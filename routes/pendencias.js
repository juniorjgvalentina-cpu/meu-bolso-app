const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const TIPOS_VALIDOS = ['pagar', 'receber'];
const FORMAS_VALIDAS = ['dinheiro', 'debito', 'credito'];

function somarMeses(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

// Cria uma pendencia nova (nome + data de vencimento; valor e opcional).
router.post('/pendencias', autenticar, async (req, res) => {
  const { tipo, nome, data_vencimento, valor } = req.body;

  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo invalido. Use pagar ou receber.' });
  }
  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome e obrigatorio.' });
  }
  if (!data_vencimento) {
    return res.status(400).json({ erro: 'Data de vencimento e obrigatoria.' });
  }

  const valorNum = valor !== undefined && valor !== null && valor !== '' ? Number(valor) : null;
  if (valorNum !== null && (isNaN(valorNum) || valorNum <= 0)) {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, valor, data_vencimento)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.conta.id, req.membro.id, tipo, nome.trim(), valorNum, data_vencimento]
    );
    res.status(201).json({ pendencia: result.rows[0] });
  } catch (err) {
    console.error('Erro ao criar pendencia:', err);
    res.status(500).json({ erro: 'Erro ao salvar. Tente novamente.' });
  }
});

// Lista pendencias nao resolvidas da conta (dono ve tudo, membro comum so as proprias).
router.get('/pendencias', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT p.*, m.nome AS membro_nome
      FROM contas_pendentes p
      LEFT JOIN membros m ON m.id = p.membro_id
      WHERE p.conta_id = $1 AND p.resolvido = FALSE
    `;
    const params = [req.conta.id];

    if (req.membro.papel !== 'dono') {
      query += ` AND p.membro_id = $2`;
      params.push(req.membro.id);
    }

    query += ` ORDER BY p.data_vencimento ASC`;

    const result = await pool.query(query, params);
    res.json({ pendencias: result.rows });
  } catch (err) {
    console.error('Erro ao listar pendencias:', err);
    res.status(500).json({ erro: 'Erro ao buscar pendencias.' });
  }
});

// Resolve uma pendencia vencida: "Paguei" ou "Recebi".
// Cria o lancamento real (com forma de pagamento/parcelas se for saida a credito)
// e marca a pendencia como resolvida, linkando ao lancamento criado.
router.post('/pendencias/:id/resolver', autenticar, async (req, res) => {
  const { valor, forma_pagamento, parcelas, categoria } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pendResult = await client.query(
      `SELECT * FROM contas_pendentes WHERE id = $1 AND conta_id = $2 AND resolvido = FALSE`,
      [req.params.id, req.conta.id]
    );
    if (pendResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Pendencia nao encontrada ou ja resolvida.' });
    }
    const pendencia = pendResult.rows[0];

    const valorFinal = Number(valor !== undefined && valor !== null && valor !== '' ? valor : pendencia.valor);
    if (!valorFinal || valorFinal <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Informe um valor valido pra concluir.' });
    }

    const tipoMovimento = pendencia.tipo === 'pagar' ? 'saida' : 'entrada';

    let categoriaFinal = null;
    let formaFinal = null;
    let totalParcelas = 1;

    if (tipoMovimento === 'saida') {
      const CATEGORIAS_VALIDAS = ['fixo', 'superfluo', 'imprevisto'];
      categoriaFinal = CATEGORIAS_VALIDAS.includes(categoria) ? categoria : 'imprevisto';
      if (!FORMAS_VALIDAS.includes(forma_pagamento)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Escolha a forma de pagamento.' });
      }
      formaFinal = forma_pagamento;
      totalParcelas = (formaFinal === 'credito' && parcelas) ? parseInt(parcelas, 10) : 1;
      if (totalParcelas < 1 || totalParcelas > 60) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Numero de parcelas invalido.' });
      }
    }

    const lancamentosCriados = [];
    const grupoParcelaId = totalParcelas > 1 ? randomUUID() : null;
    const dataBase = new Date();

    for (let i = 0; i < totalParcelas; i++) {
      const dataLancamento = i === 0 ? dataBase : somarMeses(dataBase, i);
      const result = await client.query(
        `INSERT INTO lancamentos
          (conta_id, membro_id, descricao, valor, tipo_movimento, categoria,
           forma_pagamento, parcela_atual, total_parcelas, grupo_parcela_id, data_lancamento)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          req.conta.id, req.membro.id, pendencia.nome, valorFinal, tipoMovimento,
          categoriaFinal, formaFinal,
          totalParcelas > 1 ? i + 1 : null,
          totalParcelas > 1 ? totalParcelas : null,
          grupoParcelaId,
          dataLancamento
        ]
      );
      lancamentosCriados.push(result.rows[0]);
    }

    await client.query(
      `UPDATE contas_pendentes
       SET resolvido = TRUE, data_resolucao = NOW(), valor = $1, lancamento_id = $2
       WHERE id = $3`,
      [valorFinal, lancamentosCriados[0].id, pendencia.id]
    );

    await client.query('COMMIT');
    res.json({ status: 'ok', lancamentos: lancamentosCriados });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao resolver pendencia:', err);
    res.status(500).json({ erro: 'Erro ao processar. Tente novamente.' });
  } finally {
    client.release();
  }
});

// Exclui uma pendencia sem resolver (ex: cadastrou errado).
router.delete('/pendencias/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM contas_pendentes WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Pendencia nao encontrada.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir pendencia:', err);
    res.status(500).json({ erro: 'Erro ao excluir.' });
  }
});

module.exports = router;
