const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { computarCicloFatura, proximoCicloFatura, dataFechamentoDoCiclo } = require('../utils/faturaCartao');
const { sincronizarFaturasDeCartao } = require('../utils/sincronizarFaturas');

const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const REGEX_REFERENCIA = /^\d{4}-\d{2}$/;

function validarDia(valor) {
  const n = parseInt(valor, 10);
  return n >= 1 && n <= 31 ? n : null;
}

function vencimentoDaReferencia(referencia, diaVencimento) {
  const [ano, mes] = referencia.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return `${referencia}-${String(Math.min(diaVencimento, ultimoDia)).padStart(2, '0')}`;
}

// Grava (ou apaga, se vier 0/vazio) o valor das faturas que ja existiam antes
// do app. Fatura que ja foi paga nao muda.
async function salvarValoresIniciais(client, contaId, cartaoId, valores) {
  for (const [referencia, valorBruto] of Object.entries(valores || {})) {
    if (!REGEX_REFERENCIA.test(referencia)) continue;
    const valor = Math.round(Number(valorBruto) * 100) / 100;
    if (!valor || valor <= 0 || isNaN(valor)) {
      await client.query(
        `DELETE FROM faturas_iniciais WHERE cartao_id = $1 AND conta_id = $2 AND fatura_referencia = $3 AND paga = FALSE`,
        [cartaoId, contaId, referencia]
      );
    } else {
      await client.query(
        `INSERT INTO faturas_iniciais (conta_id, cartao_id, fatura_referencia, valor)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cartao_id, fatura_referencia)
         DO UPDATE SET valor = EXCLUDED.valor
         WHERE faturas_iniciais.paga = FALSE`,
        [contaId, cartaoId, referencia, valor]
      );
    }
  }
}

router.get('/cartoes', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM cartoes WHERE conta_id = $1 ORDER BY nome ASC`,
      [req.conta.id]
    );
    res.json({ cartoes: result.rows });
  } catch (err) {
    console.error('Erro ao listar cartoes:', err);
    res.status(500).json({ erro: 'Erro ao buscar cartoes.' });
  }
});

router.post('/cartoes', autenticar, async (req, res) => {
  const { nome, dia_vencimento, dia_fechamento, faturas_iniciais } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome do cartao e obrigatorio.' });
  }
  const diaVenc = validarDia(dia_vencimento);
  if (!diaVenc) {
    return res.status(400).json({ erro: 'Dia de vencimento invalido.' });
  }
  let diaFech = 1;
  if (dia_fechamento !== undefined && dia_fechamento !== null && dia_fechamento !== '') {
    diaFech = validarDia(dia_fechamento);
    if (!diaFech) {
      return res.status(400).json({ erro: 'Dia de fechamento invalido.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cartaoResult = await client.query(
      `INSERT INTO cartoes (conta_id, nome, dia_vencimento, dia_fechamento) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.conta.id, nome.trim(), diaVenc, diaFech]
    );
    const cartao = cartaoResult.rows[0];

    const { referencia, dataVencimento } = computarCicloFatura(new Date(), diaFech, diaVenc);

    await client.query(
      `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, data_vencimento, recorrente, cartao_id, fatura_referencia)
       VALUES ($1, $2, 'pagar', $3, $4, TRUE, $5, $6)`,
      [req.conta.id, req.membro.id, `Fatura do cartão ${cartao.nome}`, dataVencimento, cartao.id, referencia]
    );

    if (faturas_iniciais && typeof faturas_iniciais === 'object') {
      await salvarValoresIniciais(client, req.conta.id, cartao.id, faturas_iniciais);
    }

    await client.query('COMMIT');
    res.status(201).json({ cartao });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar cartao:', err);
    res.status(500).json({ erro: 'Erro ao criar cartao.' });
  } finally {
    client.release();
  }
});

// Edita nome, dia que vence e dia que fecha. As faturas em aberto passam a
// vencer no dia novo.
router.put('/cartoes/:id', autenticar, async (req, res) => {
  const { nome, dia_vencimento, dia_fechamento } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome do cartao e obrigatorio.' });
  }
  const diaVenc = validarDia(dia_vencimento);
  const diaFech = validarDia(dia_fechamento);
  if (!diaVenc) return res.status(400).json({ erro: 'Dia de vencimento invalido.' });
  if (!diaFech) return res.status(400).json({ erro: 'Dia de fechamento invalido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE cartoes SET nome = $1, dia_vencimento = $2, dia_fechamento = $3
       WHERE id = $4 AND conta_id = $5 RETURNING *`,
      [nome.trim(), diaVenc, diaFech, req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Cartao nao encontrado.' });
    }
    const pendentes = await client.query(
      `SELECT id, fatura_referencia FROM contas_pendentes WHERE cartao_id = $1 AND resolvido = FALSE`,
      [req.params.id]
    );
    for (const p of pendentes.rows) {
      if (p.fatura_referencia) {
        await client.query(
          `UPDATE contas_pendentes SET nome = $1, data_vencimento = $2 WHERE id = $3`,
          [`Fatura do cartão ${nome.trim()}`, vencimentoDaReferencia(p.fatura_referencia, diaVenc), p.id]
        );
      } else {
        await client.query(`UPDATE contas_pendentes SET nome = $1 WHERE id = $2`, [`Fatura do cartão ${nome.trim()}`, p.id]);
      }
    }
    await client.query('COMMIT');
    res.json({ cartao: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao editar cartao:', err);
    res.status(500).json({ erro: 'Erro ao editar cartao.' });
  } finally {
    client.release();
  }
});

// Faturas do cartao mes a mes: a que ja fechou sem pagar, a que esta aberta
// e as futuras (parcelas que ja vao cair nos proximos meses + o valor que ja
// existia antes do app). Usado na tela "Faturas futuras".
router.get('/cartoes/:id/faturas', autenticar, async (req, res) => {
  try {
    const cartaoResult = await pool.query(
      `SELECT * FROM cartoes WHERE id = $1 AND conta_id = $2`,
      [req.params.id, req.conta.id]
    );
    if (cartaoResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Cartao nao encontrado.' });
    }
    const cartao = cartaoResult.rows[0];
    const diaFech = cartao.dia_fechamento || 1;
    const atual = computarCicloFatura(new Date(), diaFech, cartao.dia_vencimento).referencia;

    let queryItens = `
      SELECT id, descricao, valor, parcela_atual, total_parcelas, data_lancamento, fatura_referencia, categoria
      FROM lancamentos
      WHERE conta_id = $1 AND cartao_id = $2 AND forma_pagamento = 'credito' AND fatura_paga = FALSE
    `;
    const params = [req.conta.id, cartao.id];
    if (!req.membro.visao_completa) {
      queryItens += ` AND membro_id = $3`;
      params.push(req.membro.id);
    }
    queryItens += ` ORDER BY data_lancamento ASC`;
    const itensResult = await pool.query(queryItens, params);

    const iniciaisResult = await pool.query(
      `SELECT fatura_referencia, valor, paga FROM faturas_iniciais WHERE cartao_id = $1 AND conta_id = $2`,
      [cartao.id, req.conta.id]
    );
    const iniciais = {};
    iniciaisResult.rows.forEach(r => { iniciais[r.fatura_referencia] = r; });

    let inicio = atual;
    let fim = proximoCicloFatura(atual, cartao.dia_vencimento).referencia;
    for (let i = 0; i < 10; i++) fim = proximoCicloFatura(fim, cartao.dia_vencimento).referencia;
    itensResult.rows.forEach(l => {
      if (l.fatura_referencia && l.fatura_referencia < inicio) inicio = l.fatura_referencia;
      if (l.fatura_referencia && l.fatura_referencia > fim) fim = l.fatura_referencia;
    });
    iniciaisResult.rows.forEach(r => {
      if (r.paga) return;
      if (r.fatura_referencia < inicio) inicio = r.fatura_referencia;
      if (r.fatura_referencia > fim) fim = r.fatura_referencia;
    });

    const meses = [];
    let ref = inicio;
    let guarda = 0;
    while (ref <= fim && guarda < 72) {
      const [ano, mes] = ref.split('-').map(Number);
      const itens = itensResult.rows
        .filter(l => l.fatura_referencia === ref || (!l.fatura_referencia && ref === inicio))
        .map(l => ({
          id: l.id,
          descricao: l.descricao,
          valor: Number(l.valor),
          parcela_atual: l.parcela_atual,
          total_parcelas: l.total_parcelas,
          data_lancamento: l.data_lancamento,
          categoria: l.categoria
        }));
      const inicial = iniciais[ref];
      const valorInicial = inicial && !inicial.paga ? Number(inicial.valor) : 0;
      const totalCompras = itens.reduce((s, l) => s + l.valor, 0);
      meses.push({
        referencia: ref,
        nome_mes: `${NOMES_MES[mes - 1]}/${ano}`,
        data_vencimento: vencimentoDaReferencia(ref, cartao.dia_vencimento),
        data_fechamento: dataFechamentoDoCiclo(ref, diaFech, cartao.dia_vencimento),
        situacao: ref < atual ? 'fechada' : (ref === atual ? 'aberta' : 'futura'),
        valor_inicial: valorInicial,
        inicial_paga: !!(inicial && inicial.paga),
        itens,
        total: Math.round((valorInicial + totalCompras) * 100) / 100
      });
      ref = proximoCicloFatura(ref, cartao.dia_vencimento).referencia;
      guarda++;
    }

    res.json({
      cartao: { id: cartao.id, nome: cartao.nome, dia_vencimento: cartao.dia_vencimento, dia_fechamento: diaFech },
      referencia_atual: atual,
      meses
    });
  } catch (err) {
    console.error('Erro ao buscar faturas do cartao:', err);
    res.status(500).json({ erro: 'Erro ao buscar faturas.' });
  }
});

// Salva o valor das faturas que ja existiam antes do app:
// { valores: { "2026-11": 1200, "2026-12": 950.5 } } - 0 ou vazio apaga.
router.put('/cartoes/:id/faturas-iniciais', autenticar, async (req, res) => {
  const valores = req.body && req.body.valores;
  if (!valores || typeof valores !== 'object') {
    return res.status(400).json({ erro: 'Envie os valores das faturas.' });
  }

  const cartaoResult = await pool.query(
    `SELECT id FROM cartoes WHERE id = $1 AND conta_id = $2`,
    [req.params.id, req.conta.id]
  );
  if (cartaoResult.rows.length === 0) {
    return res.status(404).json({ erro: 'Cartao nao encontrado.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await salvarValoresIniciais(client, req.conta.id, Number(req.params.id), valores);
    await client.query('COMMIT');
    await sincronizarFaturasDeCartao(Number(req.params.id));
    res.json({ status: 'ok' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar faturas iniciais:', err);
    res.status(500).json({ erro: 'Erro ao salvar faturas.' });
  } finally {
    client.release();
  }
});

// Excluir cartao: so deixa se nao tiver nada sem pagar nele - senao essas
// compras ficariam "nao pagas" pra sempre e nunca sairiam do saldo.
router.delete('/cartoes/:id', autenticar, async (req, res) => {
  try {
    const cartaoResult = await pool.query(
      `SELECT id FROM cartoes WHERE id = $1 AND conta_id = $2`,
      [req.params.id, req.conta.id]
    );
    if (cartaoResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Cartao nao encontrado.' });
    }
    const emAberto = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(valor) FROM lancamentos WHERE cartao_id = $1 AND forma_pagamento = 'credito' AND fatura_paga = FALSE), 0)
         + COALESCE((SELECT SUM(valor) FROM faturas_iniciais WHERE cartao_id = $1 AND paga = FALSE), 0) AS total`,
      [req.params.id]
    );
    const totalEmAberto = Number(emAberto.rows[0].total);
    if (totalEmAberto > 0) {
      return res.status(400).json({
        erro: `Esse cartão ainda tem R$ ${totalEmAberto.toFixed(2).replace('.', ',')} em faturas sem pagar (contando as parcelas futuras). Pague as faturas ou apague essas compras antes de excluir o cartão.`
      });
    }
    await pool.query(`DELETE FROM cartoes WHERE id = $1 AND conta_id = $2`, [req.params.id, req.conta.id]);
    res.json({ status: 'ok', excluido: Number(req.params.id) });
  } catch (err) {
    console.error('Erro ao excluir cartao:', err);
    res.status(500).json({ erro: 'Erro ao excluir cartao.' });
  }
});

module.exports = router;
