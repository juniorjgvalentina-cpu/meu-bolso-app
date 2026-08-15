const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { normalizarTexto, similaridade } = require('../utils/normalizar');

const LIMIAR_SIMILARIDADE = 0.85;

// Consulta o dicionario inteligente da conta pra ver se esse item ja e
// conhecido. Retorna:
// - encontrado exato: tipo direto, sem perguntar nada
// - parecido (erro de digitacao tipo "piza"/"pizza"): sugere confirmacao
// - nada parecido: item realmente novo, front pergunta Fixo/Superfluo/Imprevisto
router.get('/itens/consultar', autenticar, async (req, res) => {
  const descricao = (req.query.descricao || '').toString();
  if (!descricao.trim()) {
    return res.status(400).json({ erro: 'Descricao nao informada.' });
  }

  const normalizado = normalizarTexto(descricao);

  try {
    const exato = await pool.query(
      `SELECT nome_item, tipo FROM itens_conhecidos
       WHERE conta_id = $1 AND nome_item_normalizado = $2`,
      [req.conta.id, normalizado]
    );

    if (exato.rows.length > 0) {
      return res.json({ status: 'conhecido', item: exato.rows[0] });
    }

    // Nao achou exato - procura por semelhanca (erro de digitacao)
    const todos = await pool.query(
      `SELECT nome_item, nome_item_normalizado, tipo FROM itens_conhecidos WHERE conta_id = $1`,
      [req.conta.id]
    );

    let melhorMatch = null;
    let melhorScore = 0;

    for (const item of todos.rows) {
      const score = similaridade(normalizado, item.nome_item_normalizado);
      if (score > melhorScore) {
        melhorScore = score;
        melhorMatch = item;
      }
    }

    if (melhorMatch && melhorScore >= LIMIAR_SIMILARIDADE) {
      return res.json({
        status: 'parecido',
        sugestao: { nome_item: melhorMatch.nome_item, tipo: melhorMatch.tipo },
        confianca: melhorScore
      });
    }

    return res.json({ status: 'novo' });
  } catch (err) {
    console.error('Erro ao consultar item:', err);
    res.status(500).json({ erro: 'Erro ao consultar dicionario.' });
  }
});

module.exports = router;
