const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const TIPOS_VALIDOS = ['pagar', 'receber'];
const FORMAS_VALIDAS = ['dinheiro', 'debito', 'credito', 'pix'];

function somarMeses(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

router.post('/pendencias', autenticar, async (req, res) => {
  const { tipo, nome, data_vencimento, valor, recorrente } = req.body;

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
      `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, valor, data_vencimento, recorrente)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.conta.id, req.membro.id, tipo, nome.trim(), valorNum, data_vencimento, !!recorrente]
    );
    res.status(201).json({ pendencia: result.rows[0] });
  } catch (err) {
    console.error('Erro ao criar pendencia:', err);
    res.status(500).json({ erro: 'Erro ao salvar. Tente novamente.' });
  }
});

router.get('/pendencias', autenticar, async (req, res) => {
  try {
    let query = `
      SELECT p.*, m.nome AS membro_nome
      FROM contas_pendentes p
      LEFT JOIN membros m ON m.id = p.membro_id
      WHERE p.conta_id = $1 AND p.resolvido = FALSE
    `;
    const params = [req.conta.id];

    if (!req.membro.visao_completa) {
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

router.post('/pendencias/:id/resolver', autenticar, async (req, res) => {
  const { valor, forma_pagamento, parcelas, categoria, cartao_id } = req.body;

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

    if (pendencia.cartao_id) {
      const marcados = await client.query(
        `UPDATE lancamentos SET fatura_paga = TRUE
         WHERE conta_id = $1 AND cartao_id = $2 AND fatura_paga = FALSE
         RETURNING id, valor`,
        [req.conta.id, pendencia.cartao_id]
      );
      const valorTotalFatura = marcados.rows.reduce((soma, l) => soma + Number(l.valor), 0);

      await client.query(
        `UPDATE contas_pendentes SET resolvido = TRUE, data_resolucao = NOW(), valor = $1 WHERE id = $2`,
        [valorTotalFatura, pendencia.id]
      );

      if (pendencia.recorrente) {
        const jaExisteProxima = await client.query(
          `SELECT 1 FROM contas_pendentes
           WHERE conta_id = $1 AND cartao_id = $2 AND recorrente = TRUE
             AND data_vencimento > $3`,
          [req.conta.id, pendencia.cartao_id, pendencia.data_vencimento]
        );
        if (jaExisteProxima.rows.length === 0) {
          const proximaData = somarMeses(new Date(pendencia.data_vencimento), 1);
          await client.query(
            `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, data_vencimento, recorrente, cartao_id)
             VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
            [req.conta.id, req.membro.id, pendencia.tipo, pendencia.nome, proximaData, pendencia.cartao_id]
          );
        }
      }

      await client.query('COMMIT');
      return res.json({ status: 'ok', fatura: true, quantidade: marcados.rows.length, valor: valorTotalFatura });
    }

    const valorFinal = Number(valor !== undefined && valor !== null && valor !== '' ? valor : pendencia.valor);
    if (!valorFinal || valorFinal <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Informe um valor valido pra concluir.' });
    }

    const tipoMovimento = pendencia.tipo === 'pagar' ? 'saida' : 'entrada';

    let categoriaFinal = null;
    let formaFinal = null;
    let totalParcelas = 1;
    let cartaoIdFinal = null;

    if (tipoMovimento === 'saida') {
      const CATEGORIAS_VALIDAS = ['fixo', 'superfluo', 'diaadia', 'imprevisto'];
      categoriaFinal = pendencia.recorrente
        ? 'fixo'
        : (CATEGORIAS_VALIDAS.includes(categoria) ? categoria : 'imprevisto');
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

      if (formaFinal === 'credito') {
        const cartaoIdNum = parseInt(cartao_id, 10);
        if (!cartaoIdNum) {
          await client.query('ROLLBACK');
          return res.status(400).json({ erro: 'Escolha o cartao usado nessa compra.' });
        }
        const cartaoResult = await client.query(
          `SELECT id FROM cartoes WHERE id = $1 AND conta_id = $2`,
          [cartaoIdNum, req.conta.id]
        );
        if (cartaoResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ erro: 'Cartao invalido.' });
        }
        cartaoIdFinal = cartaoIdNum;
      }
    }

    const lancamentosCriados = [];
    const grupoParcelaId = totalParcelas > 1 ? randomUUID() : null;
    const dataBase = new Date();

    const valorCentavosTotal = Math.round(valorFinal * 100);
    const valorCentavosParcela = Math.floor(valorCentavosTotal / totalParcelas);
    const valorCentavosUltimaParcela = valorCentavosTotal - (valorCentavosParcela * (totalParcelas - 1));

    for (let i = 0; i < totalParcelas; i++) {
      const dataLancamento = i === 0 ? dataBase : somarMeses(dataBase, i);
      const valorDaParcela = (i === totalParcelas - 1 ? valorCentavosUltimaParcela : valorCentavosParcela) / 100;
      const result = await client.query(
        `INSERT INTO lancamentos
          (conta_id, membro_id, descricao, valor, tipo_movimento, categoria,
           forma_pagamento, cartao_id, parcela_atual, total_parcelas, grupo_parcela_id, data_lancamento)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          req.conta.id, req.membro.id, pendencia.nome, valorDaParcela, tipoMovimento,
          categoriaFinal, formaFinal, cartaoIdFinal,
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

    if (pendencia.recorrente) {
      const jaExisteProxima = await client.query(
        `SELECT 1 FROM contas_pendentes
         WHERE conta_id = $1 AND tipo = $2 AND nome = $3 AND recorrente = TRUE
           AND data_vencimento > $4`,
        [req.conta.id, pendencia.tipo, pendencia.nome, pendencia.data_vencimento]
      );
      if (jaExisteProxima.rows.length === 0) {
        const proximaData = somarMeses(new Date(pendencia.data_vencimento), 1);
        await client.query(
          `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, valor, data_vencimento, recorrente)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [req.conta.id, req.membro.id, pendencia.tipo, pendencia.nome, pendencia.valor, proximaData]
        );
      }
    }

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

router.put('/pendencias/:id', autenticar, async (req, res) => {
  const { nome, data_vencimento, valor } = req.body;

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
    const pendResult = await pool.query(
      `SELECT * FROM contas_pendentes WHERE id = $1 AND conta_id = $2 AND resolvido = FALSE`,
      [req.params.id, req.conta.id]
    );
    if (pendResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Pendencia nao encontrada.' });
    }
    const pendencia = pendResult.rows[0];

    const result = await pool.query(
      `UPDATE contas_pendentes SET nome = $1, data_vencimento = $2, valor = $3 WHERE id = $4 RETURNING *`,
      [nome.trim(), data_vencimento, pendencia.cartao_id ? null : valorNum, req.params.id]
    );

    if (pendencia.cartao_id) {
      const novoDia = new Date(data_vencimento + 'T00:00:00').getDate();
      await pool.query(`UPDATE cartoes SET dia_vencimento = $1 WHERE id = $2`, [novoDia, pendencia.cartao_id]);
    }

    res.json({ pendencia: result.rows[0] });
  } catch (err) {
    console.error('Erro ao editar pendencia:', err);
    res.status(500).json({ erro: 'Erro ao editar pendencia.' });
  }
});

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
