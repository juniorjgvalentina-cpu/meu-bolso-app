const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const PLANOS = {
  individual: { valor: 12.99, limite_membros: 1, nome: 'Individual' },
  casal: { valor: 14.99, limite_membros: 2, nome: 'Casal' },
  familia: { valor: 17.99, limite_membros: 6, nome: 'Família' }
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
      total_membros: parseInt(contagemResult.rows[0].count, 10),
      planos: PLANOS
    });
  } catch (err) {
    console.error('Erro ao buscar planos:', err);
    res.status(500).json({ erro: 'Erro ao buscar planos.' });
  }
});

// Troca o plano da conta. Upgrade e imediato. Downgrade e bloqueado se
// tiver mais membros na conta do que o novo plano permite.
router.put('/planos', autenticar, apenasDono, async (req, res) => {
  const { plano } = req.body;
  if (!PLANOS[plano]) {
    return res.status(400).json({ erro: 'Plano invalido.' });
  }

  const novoPlano = PLANOS[plano];

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
      `UPDATE contas SET plano = $1, valor_plano = $2, limite_membros = $3 WHERE id = $4`,
      [plano, novoPlano.valor, novoPlano.limite_membros, req.conta.id]
    );

    res.json({ status: 'ok', plano, valor_plano: novoPlano.valor, limite_membros: novoPlano.limite_membros });
  } catch (err) {
    console.error('Erro ao trocar plano:', err);
    res.status(500).json({ erro: 'Erro ao trocar plano.' });
  }
});

module.exports = router;
