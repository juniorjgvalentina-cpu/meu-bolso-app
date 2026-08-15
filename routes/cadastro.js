const express = require('express');
const router = express.Router();
const pool = require('../db');
const { gerarToken } = require('../utils/token');

const PLANOS = {
  individual: { valor: 12.99, limite: 1 },
  casal: { valor: 14.99, limite: 2 },
  familia: { valor: 17.99, limite: 6 }
};

const DIAS_TESTE = 4;

// Cadastro inicial: cria a conta (individual/casal/familia) e o primeiro
// membro (dono). Retorna o token que fica salvo no aparelho da pessoa
// pra ela nunca mais precisar de senha.
router.post('/cadastro', async (req, res) => {
  const { nome, telefone, plano } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome e obrigatorio.' });
  }
  if (!telefone || !telefone.trim()) {
    return res.status(400).json({ erro: 'Telefone e obrigatorio.' });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');
  if (telefoneLimpo.length < 10) {
    return res.status(400).json({ erro: 'Telefone invalido. Informe DDD + numero.' });
  }

  const planoEscolhido = PLANOS[plano] ? plano : 'individual';
  const config = PLANOS[planoEscolhido];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dataVencimento = new Date();
    dataVencimento.setDate(dataVencimento.getDate() + DIAS_TESTE);

    const contaResult = await client.query(
      `INSERT INTO contas (plano, valor_plano, limite_membros, status_assinatura, data_vencimento)
       VALUES ($1, $2, $3, 'teste', $4) RETURNING id`,
      [planoEscolhido, config.valor, config.limite, dataVencimento]
    );
    const contaId = contaResult.rows[0].id;

    const token = gerarToken();

    const membroResult = await client.query(
      `INSERT INTO membros (conta_id, nome, telefone, token_acesso, papel)
       VALUES ($1, $2, $3, $4, 'dono') RETURNING id, nome, papel`,
      [contaId, nome.trim(), telefoneLimpo, token]
    );

    await client.query('COMMIT');

    res.status(201).json({
      token,
      membro: membroResult.rows[0],
      conta: {
        id: contaId,
        plano: planoEscolhido,
        status_assinatura: 'teste',
        data_vencimento: dataVencimento
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ erro: 'Esse telefone ja esta cadastrado.' });
    }
    console.error('Erro no cadastro:', err);
    res.status(500).json({ erro: 'Erro ao criar cadastro. Tente novamente.' });
  } finally {
    client.release();
  }
});

module.exports = router;
