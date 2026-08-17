const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

// Exporta TODOS os dados da pessoa (nao so o mes atual), pra "Baixar meus dados".
router.get('/dados/exportar', autenticar, async (req, res) => {
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
