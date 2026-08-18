const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const PLANOS = {
  individual: { nome: 'Individual', limite_membros: 1, mensal: 12.99, anual: 69.99 },
  casal: { nome: 'Casal', limite_membros: 2, mensal: 14.99, anual: 79.99 },
  familia: { nome: 'Família', limite_membros: 6, mensal: 17.99, anual: null }
};

function apenasDono(req, res, next) {
  if (req.membro.papel !== 'dono') {
    return res.status(403).json({ erro: 'Só o dono da conta pode fazer isso.' });
  }
  next();
}

// Retorna o plano atual da conta e quantos membros ela tem hoje.
router.get('/planos', autenticar, apenasDono, async (req, res) => {
  try {
    const contagemResult = await pool.query(
      `SELECT COUNT(*) FROM membros WHERE conta_id = $1`,
      [req.conta.id]
    );
    res.json({
      plano_atual: req.conta.plano,
      periodicidade_atual: req.conta.periodicidade || 'mensal',
      total_membros: parseInt(contagemResult.rows[0].count, 10),
      planos: PLANOS
    });
  } catch (err) {
    console.error('Erro ao buscar planos:', err);
    res.status(500).json({ erro: 'Erro ao buscar planos.' });
  }
});

// Troca o plano e/ou a periodicidade da conta. Upgrade e imediato. Downgrade
// e bloqueado se tiver mais membros na conta do que o novo plano permite.
router.put('/planos', autenticar, apenasDono, async (req, res) => {
  const { plano, periodicidade } = req.body;

  if (!PLANOS[plano]) {
    return res.status(400).json({ erro: 'Plano invalido.' });
  }
  if (!['mensal', 'anual'].includes(periodicidade)) {
    return res.status(400).json({ erro: 'Periodicidade invalida.' });
  }

  const novoPlano = PLANOS[plano];
  const novoValor = novoPlano[periodicidade];

  if (novoValor === null || novoValor === undefined) {
    return res.status(400).json({ erro: `O plano ${novoPlano.nome} nao tem opcao anual ainda.` });
  }

  try {
    const contagemResult = await pool.query(
      `SELECT COUNT(*) FROM membros WHERE conta_id = $1`,
      [req.conta.id]
    );
    const totalMembros = parseInt(contagemResult.rows[0].count, 10);

    if (totalMembros > novoPlano.limite_membros) {
      return res.status(400).json({
        erro: `Sua conta tem ${totalMembros} pessoa(s), mas o plano ${novoPlano.nome} permite no maximo ${novoPlano.limite_membros}. Remova membros antes de trocar.`
      });
    }

    await pool.query(
      `UPDATE contas SET plano = $1, periodicidade = $2, valor_plano = $3, limite_membros = $4 WHERE id = $5`,
      [plano, periodicidade, novoValor, novoPlano.limite_membros, req.conta.id]
    );

    res.json({ status: 'ok', plano, periodicidade, valor_plano: novoValor, limite_membros: novoPlano.limite_membros });
  } catch (err) {
    console.error('Erro ao trocar plano:', err);
    res.status(500).json({ erro: 'Erro ao trocar plano.' });
  }
});

module.exports = router;
