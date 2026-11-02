const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { normalizarTexto } = require('../utils/normalizar');
const { computarCicloFatura } = require('../utils/faturaCartao');
const { sincronizarFaturasDeCartao } = require('../utils/sincronizarFaturas');

const CATEGORIAS_VALIDAS = ['fixo', 'superfluo', 'diaadia', 'imprevisto'];
const FORMAS_VALIDAS = ['dinheiro', 'debito', 'credito', 'pix'];

function somarMeses(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

router.post('/lancamentos', autenticar, async (req, res) => {
  const {
    descricao, observacao, valor, tipo_movimento,
    categoria, forma_pagamento, cartao_id,
    parcelas
  } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ erro: 'Descricao e obrigatoria.' });
  }
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }
  if (!['entrada', 'saida'].includes(tipo_movimento)) {
    return res.status(400).json({ erro: 'Tipo de movimento invalido.' });
  }

  let categoriaFinal = null;
  if (tipo_movimento === 'saida') {
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ erro: 'Categoria invalida. Use fixo, superfluo, diaadia ou imprevisto.' });
    }
    categoriaFinal = categoria;
  }

  let formaFinal = null;
  let cartaoIdFinal = null;
  let cartaoInfo = null;
  if (tipo_movimento === 'saida') {
    if (!FORMAS_VALIDAS.includes(forma_pagamento)) {
      return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
    }
    formaFinal = forma_pagamento;

    if (formaFinal === 'credito') {
      const cartaoIdNum = parseInt(cartao_id, 10);
      if (!cartaoIdNum) {
        return res.status(400).json({ erro: 'Escolha o cartao usado nessa compra.' });
      }
      const cartaoResult = await pool.query(
        `SELECT id, nome, dia_fechamento, dia_vencimento FROM cartoes WHERE id = $1 AND conta_id = $2`,
        [cartaoIdNum, req.conta.id]
      );
      if (cartaoResult.rows.length === 0) {
        return res.status(400).json({ erro: 'Cartao invalido.' });
      }
      cartaoIdFinal = cartaoIdNum;
      cartaoInfo = cartaoResult.rows[0];
    }
  }

  const totalParcelas = (formaFinal === 'credito' && parcelas) ? parseInt(parcelas, 10) : 1;
  if (totalParcelas < 1 || totalParcelas > 60) {
    return res.status(400).json({ erro: 'Numero de parcelas invalido.' });
  }

  const observacaoFinal = observacao && observacao.trim() ? observacao.trim().slice(0, 200) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (tipo_movimento === 'saida' && (categoriaFinal === 'fixo' || categoriaFinal === 'superfluo' || categoriaFinal === 'diaadia')) {
      const normalizado = normalizarTexto(descricao);
      await client.query(
        `INSERT INTO itens_conhecidos (conta_id, nome_item, nome_item_normalizado, tipo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conta_id, nome_item_normalizado)
         DO UPDATE SET tipo = EXCLUDED.tipo`,
        [req.conta.id, descricao.trim(), normalizado, categoriaFinal]
      );
    }

    const lancamentosCriados = [];
    const grupoParcelaId = totalParcelas > 1 ? randomUUID() : null;
    const dataBase = new Date();

    const valorCentavosTotal = Math.round(valorNum * 100);
    const valorCentavosParcela = Math.floor(valorCentavosTotal / totalParcelas);
    const valorCentavosUltimaParcela = valorCentavosTotal - (valorCentavosParcela * (totalParcelas - 1));

    for (let i = 0; i < totalParcelas; i++) {
      const dataLancamento = i === 0 ? dataBase : somarMeses(dataBase, i);
      const valorDaParcela = (i === totalParcelas - 1 ? valorCentavosUltimaParcela : valorCentavosParcela) / 100;

      let faturaReferencia = null;
      if (cartaoInfo) {
        faturaReferencia = computarCicloFatura(dataLancamento, cartaoInfo.dia_fechamento, cartaoInfo.dia_vencimento).referencia;
      }

      const result = await client.query(
        `INSERT INTO lancamentos
          (conta_id, membro_id, descricao, observacao, valor, tipo_movimento, categoria,
           forma_pagamento, cartao_id, parcela_atual, total_parcelas, grupo_parcela_id, data_lancamento, fatura_referencia)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          req.conta.id, req.membro.id, descricao.trim(), observacaoFinal, valorDaParcela, tipo_movimento,
          categoriaFinal, formaFinal, cartaoIdFinal,
          totalParcelas > 1 ? i + 1 : null,
          totalParcelas > 1 ? totalParcelas : null,
          grupoParcelaId,
          dataLancamento,
          faturaReferencia
        ]
      );
      lancamentosCriados.push(result.rows[0]);
    }

    await client.query('COMMIT');

    // Garante a fatura aberta em A Pagar. So a fatura de AGORA aparece la -
    // as parcelas dos proximos meses ficam em "Faturas futuras" e entram em
    // A Pagar sozinhas quando a fatura anterior fechar.
    if (cartaoInfo) {
      try {
        await sincronizarFaturasDeCartao(cartaoIdFinal);
      } catch (erroSync) {
        console.error('Erro ao sincronizar faturas do cartao:', erroSync);
      }
    }

    res.status(201).json({ lancamentos: lancamentosCriados });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar lancamento:', err);
    res.status(500).json({ erro: 'Erro ao salvar lancamento. Tente novamente.' });
  } finally {
    client.release();
  }
});

router.get('/lancamentos', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT l.*, m.nome AS membro_nome, c.nome AS cartao_nome
      FROM lancamentos l
      JOIN membros m ON m.id = l.membro_id
      LEFT JOIN cartoes c ON c.id = l.cartao_id
      WHERE l.conta_id = $1
        AND date_trunc('month', l.data_lancamento) = date_trunc('month', CURRENT_DATE)
    `;
    const params = [req.conta.id];

    if (!req.membro.visao_completa) {
      query += ` AND l.membro_id = $2`;
      params.push(req.membro.id);
    }

    query += ` ORDER BY l.data_lancamento DESC`;

    const result = await pool.query(query, params);

    const totalGeralResult = await pool.query(
      `SELECT COUNT(*) AS total FROM lancamentos WHERE conta_id = $1`,
      [req.conta.id]
    );

    res.json({
      lancamentos: result.rows,
      debug_conta_id: req.conta.id,
      debug_membro_id: req.membro.id,
      debug_total_geral_da_conta: parseInt(totalGeralResult.rows[0].total, 10)
    });
  } catch (err) {
    console.error('Erro ao listar lancamentos:', err);
    res.status(500).json({ erro: 'Erro ao buscar lancamentos.' });
  }
});

router.put('/lancamentos/:id', autenticar, async (req, res) => {
  const { descricao, observacao, valor, categoria, forma_pagamento, cartao_id } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ erro: 'Descricao e obrigatoria.' });
  }
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }

  try {
    const atualResult = await pool.query(
      `SELECT * FROM lancamentos WHERE id = $1 AND conta_id = $2`,
      [req.params.id, req.conta.id]
    );
    if (atualResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Lancamento nao encontrado.' });
    }
    const atual = atualResult.rows[0];

    let categoriaFinal = atual.categoria;
    let formaFinal = atual.forma_pagamento;
    let cartaoIdFinal = atual.cartao_id;
    let faturaReferenciaFinal = atual.fatura_referencia;

    if (atual.tipo_movimento === 'saida') {
      if (!CATEGORIAS_VALIDAS.includes(categoria)) {
        return res.status(400).json({ erro: 'Categoria invalida. Use fixo, superfluo, diaadia ou imprevisto.' });
      }
      categoriaFinal = categoria;
      if (!FORMAS_VALIDAS.includes(forma_pagamento)) {
        return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
      }
      formaFinal = forma_pagamento;

      if (formaFinal === 'credito') {
        const cartaoIdNum = parseInt(cartao_id, 10) || atual.cartao_id;
        if (!cartaoIdNum) {
          return res.status(400).json({ erro: 'Escolha o cartao usado nessa compra.' });
        }
        const cartaoResult = await pool.query(
          `SELECT id, dia_fechamento, dia_vencimento FROM cartoes WHERE id = $1 AND conta_id = $2`,
          [cartaoIdNum, req.conta.id]
        );
        if (cartaoResult.rows.length === 0) {
          return res.status(400).json({ erro: 'Cartao invalido.' });
        }
        cartaoIdFinal = cartaoIdNum;
        const cartaoInfo = cartaoResult.rows[0];
        faturaReferenciaFinal = computarCicloFatura(
          new Date(atual.data_lancamento), cartaoInfo.dia_fechamento, cartaoInfo.dia_vencimento
        ).referencia;
      } else {
        cartaoIdFinal = null;
        faturaReferenciaFinal = null;
      }
    }

    const observacaoFinal = observacao && observacao.trim() ? observacao.trim().slice(0, 200) : null;

    if (atual.tipo_movimento === 'saida' && (categoriaFinal === 'fixo' || categoriaFinal === 'superfluo' || categoriaFinal === 'diaadia')) {
      const normalizado = normalizarTexto(descricao);
      await pool.query(
        `INSERT INTO itens_conhecidos (conta_id, nome_item, nome_item_normalizado, tipo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conta_id, nome_item_normalizado)
         DO UPDATE SET tipo = EXCLUDED.tipo`,
        [req.conta.id, descricao.trim(), normalizado, categoriaFinal]
      );
    }

    const result = await pool.query(
      `UPDATE lancamentos
       SET descricao = $1, observacao = $2, valor = $3, categoria = $4, forma_pagamento = $5, cartao_id = $6, fatura_referencia = $7
       WHERE id = $8 AND conta_id = $9
       RETURNING *`,
      [descricao.trim(), observacaoFinal, valorNum, categoriaFinal, formaFinal, cartaoIdFinal, faturaReferenciaFinal, req.params.id, req.conta.id]
    );

    if (cartaoIdFinal) {
      try {
        await sincronizarFaturasDeCartao(cartaoIdFinal);
      } catch (erroSync) {
        console.error('Erro ao sincronizar faturas do cartao:', erroSync);
      }
    }

    res.json({ lancamento: result.rows[0] });
  } catch (err) {
    console.error('Erro ao editar lancamento:', err);
    res.status(500).json({ erro: 'Erro ao editar lancamento.' });
  }
});

router.delete('/lancamentos/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM lancamentos WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Lancamento nao encontrado.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir lancamento:', err);
    res.status(500).json({ erro: 'Erro ao excluir lancamento.' });
  }
});

router.get('/lancamentos/fatura', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT l.*, c.nome AS cartao_nome FROM lancamentos l
      LEFT JOIN cartoes c ON c.id = l.cartao_id
      WHERE l.conta_id = $1 AND l.forma_pagamento = 'credito' AND l.fatura_paga = FALSE
    `;
    const params = [req.conta.id];
    if (!req.membro.visao_completa) {
      query += ` AND l.membro_id = $2`;
      params.push(req.membro.id);
    }
    query += ` ORDER BY l.data_lancamento DESC`;
    const result = await pool.query(query, params);

    // Valores que ja existiam no cartao antes do app entram na fatura do mes
    // deles, somando com as compras novas.
    const iniciais = await pool.query(
      `SELECT f.cartao_id, f.fatura_referencia, f.valor, c.nome AS cartao_nome
       FROM faturas_iniciais f
       JOIN cartoes c ON c.id = f.cartao_id
       WHERE f.conta_id = $1 AND f.paga = FALSE`,
      [req.conta.id]
    );
    const itensIniciais = iniciais.rows.map(f => ({
      id: `inicial-${f.cartao_id}-${f.fatura_referencia}`,
      saldo_inicial: true,
      descricao: 'Parcelas de antes do app',
      cartao_id: f.cartao_id,
      cartao_nome: f.cartao_nome,
      fatura_referencia: f.fatura_referencia,
      valor: f.valor,
      forma_pagamento: 'credito',
      fatura_paga: false
    }));

    res.json({ itens: result.rows.concat(itensIniciais) });
  } catch (err) {
    console.error('Erro ao buscar fatura:', err);
    res.status(500).json({ erro: 'Erro ao buscar fatura.' });
  }
});

router.get('/lancamentos/pagos-cross-mes', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT l.*, c.nome AS cartao_nome FROM lancamentos l
      LEFT JOIN cartoes c ON c.id = l.cartao_id
      WHERE l.conta_id = $1
        AND l.forma_pagamento = 'credito' AND l.fatura_paga = TRUE
        AND date_trunc('month', l.fatura_paga_em) = date_trunc('month', CURRENT_DATE)
        AND date_trunc('month', l.data_lancamento) != date_trunc('month', CURRENT_DATE)
    `;
    const params = [req.conta.id];
    if (!req.membro.visao_completa) {
      query += ` AND l.membro_id = $2`;
      params.push(req.membro.id);
    }
    const result = await pool.query(query, params);

    // Fatura com parcelas de antes do app paga neste mes tambem saiu do bolso.
    let itensIniciais = [];
    if (req.membro.visao_completa) {
      const iniciais = await pool.query(
        `SELECT f.cartao_id, f.fatura_referencia, f.valor, c.nome AS cartao_nome
         FROM faturas_iniciais f
         JOIN cartoes c ON c.id = f.cartao_id
         WHERE f.conta_id = $1 AND f.paga = TRUE
           AND date_trunc('month', f.paga_em) = date_trunc('month', CURRENT_DATE)`,
        [req.conta.id]
      );
      itensIniciais = iniciais.rows.map(f => ({
        saldo_inicial: true,
        descricao: 'Parcelas de antes do app',
        cartao_id: f.cartao_id,
        cartao_nome: f.cartao_nome,
        fatura_referencia: f.fatura_referencia,
        valor: f.valor
      }));
    }

    res.json({ itens: result.rows.concat(itensIniciais) });
  } catch (err) {
    console.error('Erro ao buscar pagos cross-mes:', err);
    res.status(500).json({ erro: 'Erro ao buscar.' });
  }
});

router.get('/lancamentos/saldo-total', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT tipo_movimento, forma_pagamento, fatura_paga, SUM(valor) AS total
      FROM lancamentos
      WHERE conta_id = $1
    `;
    const params = [req.conta.id];
    if (!req.membro.visao_completa) {
      query += ` AND membro_id = $2`;
      params.push(req.membro.id);
    }
    query += ` GROUP BY tipo_movimento, forma_pagamento, fatura_paga`;
    const result = await pool.query(query, params);

    let saldo = 0;
    result.rows.forEach(r => {
      const valor = Number(r.total);
      if (r.tipo_movimento === 'entrada') {
        saldo += valor;
      } else {
        const pago = r.forma_pagamento !== 'credito' || r.fatura_paga;
        if (pago) saldo -= valor;
      }
    });

    // Parcelas de antes do app que ja foram pagas tambem saem do saldo.
    if (req.membro.visao_completa) {
      const iniciaisPagas = await pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM faturas_iniciais WHERE conta_id = $1 AND paga = TRUE`,
        [req.conta.id]
      );
      saldo -= Number(iniciaisPagas.rows[0].total);
    }

    res.json({ saldo });
  } catch (err) {
    console.error('Erro ao calcular saldo total:', err);
    res.status(500).json({ erro: 'Erro ao calcular saldo total.' });
  }
});

module.exports = router;
