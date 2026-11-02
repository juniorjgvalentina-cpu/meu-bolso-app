const pool = require('../db');
const { computarCicloFatura } = require('./faturaCartao');

// Faturas de cartao: mantem em A Pagar so o que interessa agora:
// - a fatura que esta ABERTA hoje (recebendo compras);
// - faturas que ja FECHARAM e ainda nao foram pagas.
// Faturas futuras (parcelas dos proximos meses) NAO ficam em A Pagar - elas
// aparecem sozinhas quando a fatura anterior fecha, e da pra ver antes na
// tela "Faturas futuras". Tambem remove faturas adiantadas/duplicadas que
// uma versao antiga criava numa compra parcelada.
async function sincronizarFaturasDeCartao(cartaoId) {
  let geradas = 0;
  let removidas = 0;
  const cartoes = await pool.query(`
    SELECT c.id, c.conta_id, c.nome, c.dia_fechamento, c.dia_vencimento,
           (SELECT m.id FROM membros m WHERE m.conta_id = c.conta_id AND m.papel = 'dono' ORDER BY m.id LIMIT 1) AS dono_id
    FROM cartoes c
    ${cartaoId ? 'WHERE c.id = $1' : ''}
  `, cartaoId ? [cartaoId] : []);

  for (const c of cartoes.rows) {
    const atual = computarCicloFatura(new Date(), c.dia_fechamento || 1, c.dia_vencimento).referencia;

    // Compras antigas no credito, de antes de existir o "mes da fatura":
    // calcula o mes certo pela data da compra (so as que ainda nao foram pagas).
    const semMes = await pool.query(
      `SELECT id, data_lancamento FROM lancamentos
       WHERE cartao_id = $1 AND forma_pagamento = 'credito' AND fatura_paga = FALSE AND fatura_referencia IS NULL`,
      [c.id]
    );
    for (const l of semMes.rows) {
      const ref = computarCicloFatura(new Date(l.data_lancamento), c.dia_fechamento || 1, c.dia_vencimento).referencia;
      await pool.query(`UPDATE lancamentos SET fatura_referencia = $1 WHERE id = $2`, [ref, l.id]);
    }

    // Fatura pendente antiga sem mes definido: vira a fatura mais antiga em
    // aberto (assim nao aparecem duas faturas do mesmo mes).
    const pendSemMes = await pool.query(
      `SELECT id FROM contas_pendentes
       WHERE cartao_id = $1 AND resolvido = FALSE AND fatura_referencia IS NULL
       ORDER BY data_vencimento ASC, id ASC`,
      [c.id]
    );
    if (pendSemMes.rows.length > 0) {
      const maisAntiga = await pool.query(
        `SELECT MIN(ref) AS ref FROM (
           SELECT fatura_referencia AS ref FROM lancamentos
           WHERE cartao_id = $1 AND forma_pagamento = 'credito' AND fatura_paga = FALSE AND fatura_referencia IS NOT NULL
           UNION ALL
           SELECT fatura_referencia FROM faturas_iniciais WHERE cartao_id = $1 AND paga = FALSE
         ) t WHERE ref <= $2`,
        [c.id, atual]
      );
      const ref = maisAntiga.rows[0].ref || atual;
      const jaTemEssa = await pool.query(
        `SELECT 1 FROM contas_pendentes WHERE cartao_id = $1 AND resolvido = FALSE AND fatura_referencia = $2`,
        [c.id, ref]
      );
      for (let i = 0; i < pendSemMes.rows.length; i++) {
        const id = pendSemMes.rows[i].id;
        if (i === 0 && jaTemEssa.rows.length === 0) {
          const [ano, mes] = ref.split('-').map(Number);
          const dia = Math.min(c.dia_vencimento, new Date(ano, mes, 0).getDate());
          await pool.query(
            `UPDATE contas_pendentes SET fatura_referencia = $1, data_vencimento = $2 WHERE id = $3`,
            [ref, `${ref}-${String(dia).padStart(2, '0')}`, id]
          );
        } else {
          await pool.query(`DELETE FROM contas_pendentes WHERE id = $1`, [id]);
          removidas++;
        }
      }
    }

    const r1 = await pool.query(
      `DELETE FROM contas_pendentes
       WHERE cartao_id = $1 AND resolvido = FALSE AND fatura_referencia IS NOT NULL AND fatura_referencia > $2`,
      [c.id, atual]
    );
    const r2 = await pool.query(
      `DELETE FROM contas_pendentes p
       WHERE p.cartao_id = $1 AND p.resolvido = FALSE AND p.fatura_referencia IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM contas_pendentes p2
           WHERE p2.cartao_id = p.cartao_id AND p2.resolvido = FALSE
             AND p2.fatura_referencia = p.fatura_referencia AND p2.id < p.id
         )`,
      [c.id]
    );
    removidas += (r1.rowCount || 0) + (r2.rowCount || 0);

    // Referencias que precisam de pendencia: a fatura aberta agora (se ainda
    // nao teve nenhuma) e qualquer fatura ja fechada com valor sem pagar.
    const precisa = new Set();
    const jaTeveAtual = await pool.query(
      `SELECT 1 FROM contas_pendentes WHERE cartao_id = $1 AND fatura_referencia = $2 LIMIT 1`,
      [c.id, atual]
    );
    if (jaTeveAtual.rows.length === 0) precisa.add(atual);

    const naoPagas = await pool.query(
      `SELECT DISTINCT fatura_referencia AS ref FROM lancamentos
       WHERE cartao_id = $1 AND forma_pagamento = 'credito' AND fatura_paga = FALSE
         AND fatura_referencia IS NOT NULL AND fatura_referencia <= $2
       UNION
       SELECT DISTINCT fatura_referencia AS ref FROM faturas_iniciais
       WHERE cartao_id = $1 AND paga = FALSE AND fatura_referencia <= $2`,
      [c.id, atual]
    );
    naoPagas.rows.forEach(r => precisa.add(r.ref));

    for (const ref of precisa) {
      const existe = await pool.query(
        `SELECT 1 FROM contas_pendentes WHERE cartao_id = $1 AND fatura_referencia = $2 AND resolvido = FALSE`,
        [c.id, ref]
      );
      if (existe.rows.length > 0) continue;
      const [ano, mes] = ref.split('-').map(Number);
      const ultimoDia = new Date(ano, mes, 0).getDate();
      const dia = Math.min(c.dia_vencimento, ultimoDia);
      const vencimento = `${ref}-${String(dia).padStart(2, '0')}`;
      await pool.query(
        `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, data_vencimento, recorrente, cartao_id, fatura_referencia)
         VALUES ($1, $2, 'pagar', $3, $4, TRUE, $5, $6)`,
        [c.conta_id, c.dono_id, `Fatura do cartão ${c.nome}`, vencimento, c.id, ref]
      );
      geradas++;
    }
  }
  return { geradas, removidas };
}

module.exports = { sincronizarFaturasDeCartao };
