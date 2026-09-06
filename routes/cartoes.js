const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { computarCicloFatura } = require('../utils/faturaCartao');

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
  const { nome, dia_vencimento, dia_fechamento } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome do cartao e obrigatorio.' });
  }
  const diaVenc = parseInt(dia_vencimento, 10);
  if (!diaVenc || diaVenc < 1 || diaVenc > 31) {
    return res.status(400).json({ erro: 'Dia de vencimento invalido.' });
  }
  const diaFech = parseInt(dia_fechamento, 10);
  if (!diaFech || diaFech < 1 || diaFech > 31) {
    return res.status(400).json({ erro: 'Dia de fechamento invalido.' });
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

router.delete('/cartoes/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cartoes WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cartao nao encontrado.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir cartao:', err);
    res.status(500).json({ erro: 'Erro ao excluir cartao.' });
  }
});

module.exports = router;
