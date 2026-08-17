const express = require('express');
const router = express.Router();
const pool = require('../db');

// Autenticacao que aceita tanto o cabecalho x-token (usado por fetch) quanto
// o token na propria URL (necessario pra link de download direto, que e o
// jeito mais confiavel de baixar arquivo no Safari do iPhone).
async function autenticarFlexivel(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (!token) {
    return res.status(401).json({ erro: 'Token nao fornecido.' });
  }
  try {
    const result = await pool.query(
      `SELECT m.id AS membro_id, m.nome, m.papel, m.conta_id
       FROM membros m WHERE m.token_acesso = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Token invalido.' });
    }
    const row = result.rows[0];
    req.membro = { id: row.membro_id, nome: row.nome, papel: row.papel };
    req.conta = { id: row.conta_id };
    next();
  } catch (err) {
    console.error('Erro ao autenticar dados:', err);
    res.status(500).json({ erro: 'Erro de autenticacao.' });
  }
}

// Exporta TODOS os dados da pessoa (nao so o mes atual), pra "Baixar meus dados".
router.get('/dados/exportar', autenticarFlexivel, async (req, res) => {
  try {
    const apenasProprio = req.membro.papel !== 'dono';

    let queryLancamentos = `SELECT * FROM lancamentos WHERE conta_id = $1`;
    const paramsLancamentos = [req.conta.id];
    if (apenasProprio) {
      queryLancamentos += ` AND membro_id = $2`;
      paramsLancamentos.push(req.membro.id);
    }
    queryLancamentos += ` ORDER BY data_lancamento DESC`;

    let queryPendencias = `SELECT * FROM contas_pendentes WHERE conta_id = $1`;
    const paramsPendencias = [req.conta.id];
    if (apenasProprio) {
      queryPendencias += ` AND membro_id = $2`;
      paramsPendencias.push(req.membro.id);
    }
    queryPendencias += ` ORDER BY data_vencimento DESC`;

    const [lancamentosResult, pendenciasResult, dicionarioResult] = await Promise.all([
      pool.query(queryLancamentos, paramsLancamentos),
      pool.query(queryPendencias, paramsPendencias),
      pool.query(
        `SELECT nome_item, tipo, data_criacao FROM itens_conhecidos WHERE conta_id = $1 ORDER BY nome_item ASC`,
        [req.conta.id]
      )
    ]);

    const pacote = {
      exportado_em: new Date().toISOString(),
      membro: { nome: req.membro.nome, papel: req.membro.papel },
      lancamentos: lancamentosResult.rows,
      contas_pendentes: pendenciasResult.rows,
      dicionario: dicionarioResult.rows
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="meu-bolso-dados.json"`);
    res.send(JSON.stringify(pacote, null, 2));
  } catch (err) {
    console.error('Erro ao exportar dados:', err);
    res.status(500).json({ erro: 'Erro ao exportar dados.' });
  }
});

module.exports = router;
