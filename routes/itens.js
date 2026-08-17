const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { normalizarTexto, similaridade } = require('../utils/normalizar');

const LIMIAR_SIMILARIDADE = 0.85;
const TIPOS_EDITAVEIS = ['fixo', 'superfluo'];

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

// Cria um item novo manualmente no dicionario (Configuracoes > "+ Novo item").
// Se ja existir um item com esse nome, so atualiza a categoria dele.
router.post('/itens', autenticar, async (req, res) => {
  const { nome_item, tipo } = req.body;

  if (!nome_item || !nome_item.trim()) {
    return res.status(400).json({ erro: 'Nome do item e obrigatorio.' });
  }
  if (!TIPOS_EDITAVEIS.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo invalido. Use fixo ou superfluo.' });
  }

  const normalizado = normalizarTexto(nome_item);

  try {
    const result = await pool.query(
      `INSERT INTO itens_conhecidos (conta_id, nome_item, nome_item_normalizado, tipo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conta_id, nome_item_normalizado)
       DO UPDATE SET tipo = EXCLUDED.tipo, nome_item = EXCLUDED.nome_item
       RETURNING *`,
      [req.conta.id, nome_item.trim(), normalizado, tipo]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error('Erro ao criar item:', err);
    res.status(500).json({ erro: 'Erro ao criar item.' });
  }
});

// Lista todos os itens do dicionario da conta (tela de Configuracoes).
router.get('/itens', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome_item, tipo, data_criacao
       FROM itens_conhecidos
       WHERE conta_id = $1
       ORDER BY nome_item ASC`,
      [req.conta.id]
    );
    res.json({ itens: result.rows });
  } catch (err) {
    console.error('Erro ao listar itens:', err);
    res.status(500).json({ erro: 'Erro ao buscar dicionario.' });
  }
});

// Edita a categoria (Fixo/Superfluo) de um item do dicionario.
// Imprevisto nunca fica salvo no dicionario, entao nao e uma opcao aqui.
router.put('/itens/:id', autenticar, async (req, res) => {
  const { tipo } = req.body;
  if (!TIPOS_EDITAVEIS.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo invalido. Use fixo ou superfluo.' });
  }

  try {
    const result = await pool.query(
      `UPDATE itens_conhecidos SET tipo = $1 WHERE id = $2 AND conta_id = $3 RETURNING *`,
      [tipo, req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Item nao encontrado.' });
    }
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('Erro ao editar item:', err);
    res.status(500).json({ erro: 'Erro ao editar item.' });
  }
});

// Remove um item do dicionario (a proxima vez que a pessoa digitar essa
// descricao, o sistema pergunta a categoria de novo, como se fosse novo).
router.delete('/itens/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM itens_conhecidos WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Item nao encontrado.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir item:', err);
    res.status(500).json({ erro: 'Erro ao excluir item.' });
  }
});

module.exports = router;
