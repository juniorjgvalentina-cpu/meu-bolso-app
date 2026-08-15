const express = require('express');
const router = express.Router();
const pool = require('../db');
const { gerarToken } = require('../utils/token');

// Confere se uma conta esta vencida na hora do login (alem do job diario,
// pra garantir que o status esteja sempre correto mesmo se o cron atrasar).
async function atualizarStatusSeVencido(client, conta) {
  if (conta.status_assinatura === 'vencido') return conta;
  const agora = new Date();
  const vencimento = conta.data_vencimento ? new Date(conta.data_vencimento) : null;
  if (vencimento && agora > vencimento) {
    await client.query(
      `UPDATE contas SET status_assinatura = 'vencido' WHERE id = $1`,
      [conta.id]
    );
    conta.status_assinatura = 'vencido';
  }
  return conta;
}

// Login por token: e a rota que roda toda vez que o app abre.
// Sem senha - so confere se o token salvo no aparelho ainda e valido.
router.post('/login', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ erro: 'Token nao informado.' });
  }

  const client = await pool.connect();
  try {
    const membroResult = await client.query(
      `SELECT m.id, m.nome, m.papel, m.conta_id
       FROM membros m WHERE m.token_acesso = $1`,
      [token]
    );

    if (membroResult.rows.length === 0) {
      return res.status(401).json({ erro: 'Token invalido. Faca login novamente.' });
    }

    const membro = membroResult.rows[0];

    const contaResult = await client.query(
      `SELECT id, plano, valor_plano, limite_membros, status_assinatura, data_vencimento
       FROM contas WHERE id = $1`,
      [membro.conta_id]
    );

    if (contaResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Conta nao encontrada.' });
    }

    let conta = contaResult.rows[0];
    conta = await atualizarStatusSeVencido(client, conta);

    res.json({ membro, conta });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ erro: 'Erro ao entrar. Tente novamente.' });
  } finally {
    client.release();
  }
});

// Recuperacao de acesso: quando a pessoa troca de aparelho ou perde o token.
// Confirma pelo telefone cadastrado e gera um token NOVO - os dados antigos
// continuam no servidor, nada e apagado.
router.post('/recuperar', async (req, res) => {
  const { telefone } = req.body;
  if (!telefone || !telefone.trim()) {
    return res.status(400).json({ erro: 'Telefone e obrigatorio.' });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');

  const client = await pool.connect();
  try {
    const membroResult = await client.query(
      `SELECT id, nome, papel, conta_id FROM membros WHERE telefone = $1`,
      [telefoneLimpo]
    );

    if (membroResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Nenhum cadastro encontrado com esse telefone.' });
    }

    const membro = membroResult.rows[0];
    const novoToken = gerarToken();

    await client.query(
      `UPDATE membros SET token_acesso = $1 WHERE id = $2`,
      [novoToken, membro.id]
    );

    const contaResult = await client.query(
      `SELECT id, plano, valor_plano, limite_membros, status_assinatura, data_vencimento
       FROM contas WHERE id = $1`,
      [membro.conta_id]
    );

    let conta = contaResult.rows[0];
    conta = await atualizarStatusSeVencido(client, conta);

    res.json({
      token: novoToken,
      membro: { id: membro.id, nome: membro.nome, papel: membro.papel },
      conta
    });
  } catch (err) {
    console.error('Erro na recuperacao:', err);
    res.status(500).json({ erro: 'Erro ao recuperar acesso. Tente novamente.' });
  } finally {
    client.release();
  }
});

module.exports = router;
