const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { normalizarTexto } = require('../utils/normalizar');

const CATEGORIAS_VALIDAS = ['fixo', 'superfluo', 'diaadia', 'imprevisto'];
const FORMAS_VALIDAS = ['dinheiro', 'debito', 'credito', 'pix'];

// Soma meses a uma data, ajustando pro ultimo dia do mes quando o dia
// original nao existir no mes seguinte (mesma regra usada na cobranca).
function somarMeses(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

// Cria um lancamento novo. Se for saida com categoria fixo/superfluo,
// aprende no dicionario da conta (imprevisto NUNCA e gravado no dicionario).
// Se for credito parcelado, gera um lancamento por mes automaticamente.
router.post('/lancamentos', autenticar, async (req, res) => {
  const {
    descricao, observacao, valor, tipo_movimento,
    categoria, forma_pagamento,
    parcelas
  } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ erro: 'Descricao e obrigatoria.' });
  }
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }
  if (!['entrada', 'saida'].includes(tipo_movimento)) {
    return res.status(400).json({ erro: 'Tipo de movimento invalido.' });
  }

  let categoriaFinal = null;
  if (tipo_movimento === 'saida') {
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ erro: 'Categoria invalida. Use fixo, superfluo, diaadia ou imprevisto.' });
    }
    categoriaFinal = categoria;
  }

  let formaFinal = null;
  if (tipo_movimento === 'saida') {
    if (!FORMAS_VALIDAS.includes(forma_pagamento)) {
      return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
    }
    formaFinal = forma_pagamento;
  }

  const totalParcelas = (formaFinal === 'credito' && parcelas) ? parseInt(parcelas, 10) : 1;
  if (totalParcelas < 1 || totalParcelas > 60) {
    return res.status(400).json({ erro: 'Numero de parcelas invalido.' });
  }

  const observacaoFinal = observacao && observacao.trim() ? observacao.trim().slice(0, 200) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Aprende no dicionario - fixo/superfluo/diaadia, nunca imprevisto
    if (tipo_movimento === 'saida' && (categoriaFinal === 'fixo' || categoriaFinal === 'superfluo' || categoriaFinal === 'diaadia')) {
      const normalizado = normalizarTexto(descricao);
      await client.query(
        `INSERT INTO itens_conhecidos (conta_id, nome_item, nome_item_normalizado, tipo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conta_id, nome_item_normalizado)
         DO UPDATE SET tipo = EXCLUDED.tipo`,
        [req.conta.id, descricao.trim(), normalizado, categoriaFinal]
      );
    }

    const lancamentosCriados = [];
    const grupoParcelaId = totalParcelas > 1 ? randomUUID() : null;
    const dataBase = new Date();

    for (let i = 0; i < totalParcelas; i++) {
      const dataLancamento = i === 0 ? dataBase : somarMeses(dataBase, i);

      const result = await client.query(
        `INSERT INTO lancamentos
          (conta_id, membro_id, descricao, observacao, valor, tipo_movimento, categoria,
           forma_pagamento, parcela_atual, total_parcelas, grupo_parcela_id, data_lancamento)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          req.conta.id, req.membro.id, descricao.trim(), observacaoFinal, valorNum, tipo_movimento,
          categoriaFinal, formaFinal,
          totalParcelas > 1 ? i + 1 : null,
          totalParcelas > 1 ? totalParcelas : null,
          grupoParcelaId,
          dataLancamento
        ]
      );
      lancamentosCriados.push(result.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ lancamentos: lancamentosCriados });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar lancamento:', err);
    res.status(500).json({ erro: 'Erro ao salvar lancamento. Tente novamente.' });
  } finally {
    client.release();
  }
});

// Lista os lancamentos do mes atual (usado na Home pra calcular saldo
// e na tela de Planilha). Dono ve tudo da conta, membro comum ve so os proprios.
router.get('/lancamentos', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT l.*, m.nome AS membro_nome
      FROM lancamentos l
      JOIN membros m ON m.id = l.membro_id
      WHERE l.conta_id = $1
        AND date_trunc('month', l.data_lancamento) = date_trunc('month', CURRENT_DATE)
    `;
    const params = [req.conta.id];

    if (!req.membro.visao_completa) {
      query += ` AND l.membro_id = $2`;
      params.push(req.membro.id);
    }

    query += ` ORDER BY l.data_lancamento DESC`;

    const result = await pool.query(query, params);
    res.json({ lancamentos: result.rows });
  } catch (err) {
    console.error('Erro ao listar lancamentos:', err);
    res.status(500).json({ erro: 'Erro ao buscar lancamentos.' });
  }
});

// Edita um lancamento existente - descricao, observacao, valor e (se for saida)
// categoria/forma de pagamento. Nao mexe em parcelamento nem tipo_movimento,
// pra nao complicar a estrutura de parcelas ja criadas.
router.put('/lancamentos/:id', autenticar, async (req, res) => {
  const { descricao, observacao, valor, categoria, forma_pagamento } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ erro: 'Descricao e obrigatoria.' });
  }
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }

  try {
    const atualResult = await pool.query(
      `SELECT * FROM lancamentos WHERE id = $1 AND conta_id = $2`,
      [req.params.id, req.conta.id]
    );
    if (atualResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Lancamento nao encontrado.' });
    }
    const atual = atualResult.rows[0];

    let categoriaFinal = atual.categoria;
    let formaFinal = atual.forma_pagamento;

    if (atual.tipo_movimento === 'saida') {
      if (!CATEGORIAS_VALIDAS.includes(categoria)) {
        return res.status(400).json({ erro: 'Categoria invalida. Use fixo, superfluo, diaadia ou imprevisto.' });
      }
      categoriaFinal = categoria;
      if (!FORMAS_VALIDAS.includes(forma_pagamento)) {
        return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
      }
      formaFinal = forma_pagamento;
    }

    const observacaoFinal = observacao && observacao.trim() ? observacao.trim().slice(0, 200) : null;

    // Se mudou a categoria pra fixo/superfluo/diaadia, atualiza o dicionario tambem.
    if (atual.tipo_movimento === 'saida' && (categoriaFinal === 'fixo' || categoriaFinal === 'superfluo' || categoriaFinal === 'diaadia')) {
      const normalizado = normalizarTexto(descricao);
      await pool.query(
        `INSERT INTO itens_conhecidos (conta_id, nome_item, nome_item_normalizado, tipo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conta_id, nome_item_normalizado)
         DO UPDATE SET tipo = EXCLUDED.tipo`,
        [req.conta.id, descricao.trim(), normalizado, categoriaFinal]
      );
    }

    const result = await pool.query(
      `UPDATE lancamentos
       SET descricao = $1, observacao = $2, valor = $3, categoria = $4, forma_pagamento = $5
       WHERE id = $6 AND conta_id = $7
       RETURNING *`,
      [descricao.trim(), observacaoFinal, valorNum, categoriaFinal, formaFinal, req.params.id, req.conta.id]
    );

    res.json({ lancamento: result.rows[0] });
  } catch (err) {
    console.error('Erro ao editar lancamento:', err);
    res.status(500).json({ erro: 'Erro ao editar lancamento.' });
  }
});

// Exclusao de lancamento - sempre exige confirmacao no front antes de chamar aqui.
router.delete('/lancamentos/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM lancamentos WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Lancamento nao encontrado.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir lancamento:', err);
    res.status(500).json({ erro: 'Erro ao excluir lancamento.' });
  }
});

module.exports = router;
