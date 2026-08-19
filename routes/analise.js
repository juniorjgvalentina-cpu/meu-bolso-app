const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const CATEGORIAS = ['fixo', 'superfluo', 'diaadia', 'imprevisto'];

// Meta e orcamento nao sao mais "por mes": ficam valendo ate o usuario mudar/cancelar.
// Usamos esse valor fixo no lugar do mes real, reaproveitando a coluna mes_referencia
// que ja existia (sem precisar migrar o banco).
const REFERENCIA_PADRAO = 'padrao';

async function totaisDoMes(contaId, membroId, apenasProprio, offsetMeses) {
  let query = `
    SELECT tipo_movimento, categoria, SUM(valor) AS total
    FROM lancamentos
    WHERE conta_id = $1
      AND date_trunc('month', data_lancamento) = date_trunc('month', CURRENT_DATE + ($2 || ' months')::interval)
  `;
  const params = [contaId, offsetMeses];

  if (apenasProprio) {
    query += ` AND membro_id = $3`;
    params.push(membroId);
  }

  query += ` GROUP BY tipo_movimento, categoria`;

  const result = await pool.query(query, params);

  const totais = { entrada: 0, fixo: 0, superfluo: 0, diaadia: 0, imprevisto: 0 };
  result.rows.forEach(r => {
    const valor = Number(r.total);
    if (r.tipo_movimento === 'entrada') {
      totais.entrada += valor;
    } else if (CATEGORIAS.includes(r.categoria)) {
      totais[r.categoria] += valor;
    }
  });
  totais.totalGasto = totais.fixo + totais.superfluo + totais.diaadia + totais.imprevisto;
  totais.saldo = totais.entrada - totais.totalGasto;
  return totais;
}

// Retorna tudo que a tela de Analise precisa numa unica chamada.
router.get('/analise', autenticar, async (req, res) => {
  try {
    const apenasProprio = !req.membro.visao_completa;

    const [mesAtual, mesAnterior] = await Promise.all([
      totaisDoMes(req.conta.id, req.membro.id, apenasProprio, '0'),
      totaisDoMes(req.conta.id, req.membro.id, apenasProprio, '-1')
    ]);

    let rankingQuery = `
      SELECT descricao, categoria, SUM(valor) AS total
      FROM lancamentos
      WHERE conta_id = $1
        AND tipo_movimento = 'saida'
        AND date_trunc('month', data_lancamento) = date_trunc('month', CURRENT_DATE)
    `;
    const rankingParams = [req.conta.id];
    if (apenasProprio) {
      rankingQuery += ` AND membro_id = $2`;
      rankingParams.push(req.membro.id);
    }
    rankingQuery += ` GROUP BY descricao, categoria ORDER BY total DESC LIMIT 5`;
    const rankingResult = await pool.query(rankingQuery, rankingParams);

    const metaResult = await pool.query(
      `SELECT valor_meta_economia FROM metas WHERE conta_id = $1 AND mes_referencia = $2`,
      [req.conta.id, REFERENCIA_PADRAO]
    );

    const orcamentosResult = await pool.query(
      `SELECT categoria, valor_teto FROM orcamentos WHERE conta_id = $1 AND mes_referencia = $2`,
      [req.conta.id, REFERENCIA_PADRAO]
    );
    const orcamentos = CATEGORIAS.map(cat => {
      const registro = orcamentosResult.rows.find(o => o.categoria === cat);
      return {
        categoria: cat,
        valor_teto: registro ? Number(registro.valor_teto) : null,
        gasto_atual: mesAtual[cat]
      };
    });

    res.json({
      mesAtual,
      mesAnterior,
      ranking: rankingResult.rows.map(r => ({ ...r, total: Number(r.total) })),
      meta: metaResult.rows[0] ? Number(metaResult.rows[0].valor_meta_economia) : null,
      orcamentos
    });
  } catch (err) {
    console.error('Erro ao buscar analise:', err);
    res.status(500).json({ erro: 'Erro ao buscar dados de analise.' });
  }
});

// Define/atualiza a meta de economia (fica valendo ate o usuario mudar).
router.post('/analise/meta', autenticar, async (req, res) => {
  const { valor_meta_economia } = req.body;
  const valorNum = Number(valor_meta_economia);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor de meta invalido.' });
  }

  try {
    await pool.query(
      `INSERT INTO metas (conta_id, valor_meta_economia, mes_referencia)
       VALUES ($1, $2, $3)
       ON CONFLICT (conta_id, mes_referencia)
       DO UPDATE SET valor_meta_economia = EXCLUDED.valor_meta_economia`,
      [req.conta.id, valorNum, REFERENCIA_PADRAO]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Erro ao salvar meta:', err);
    res.status(500).json({ erro: 'Erro ao salvar meta.' });
  }
});

// Cancela a meta de economia atual.
router.delete('/analise/meta', autenticar, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM metas WHERE conta_id = $1 AND mes_referencia = $2`,
      [req.conta.id, REFERENCIA_PADRAO]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Erro ao cancelar meta:', err);
    res.status(500).json({ erro: 'Erro ao cancelar meta.' });
  }
});

// Define/atualiza o teto de orcamento de uma categoria (fica valendo ate o usuario mudar).
router.post('/analise/orcamento', autenticar, async (req, res) => {
  const { categoria, valor_teto } = req.body;
  if (!CATEGORIAS.includes(categoria)) {
    return res.status(400).json({ erro: 'Categoria invalida.' });
  }
  const valorNum = Number(valor_teto);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor de orcamento invalido.' });
  }

  try {
    await pool.query(
      `INSERT INTO orcamentos (conta_id, categoria, valor_teto, mes_referencia)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conta_id, categoria, mes_referencia)
       DO UPDATE SET valor_teto = EXCLUDED.valor_teto`,
      [req.conta.id, categoria, valorNum, REFERENCIA_PADRAO]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Erro ao salvar orcamento:', err);
    res.status(500).json({ erro: 'Erro ao salvar orcamento.' });
  }
});

// Cancela o orcamento de uma categoria.
router.delete('/analise/orcamento/:categoria', autenticar, async (req, res) => {
  const { categoria } = req.params;
  if (!CATEGORIAS.includes(categoria)) {
    return res.status(400).json({ erro: 'Categoria invalida.' });
  }

  try {
    await pool.query(
      `DELETE FROM orcamentos WHERE conta_id = $1 AND categoria = $2 AND mes_referencia = $3`,
      [req.conta.id, categoria, REFERENCIA_PADRAO]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Erro ao cancelar orcamento:', err);
    res.status(500).json({ erro: 'Erro ao cancelar orcamento.' });
  }
});

module.exports = router;
