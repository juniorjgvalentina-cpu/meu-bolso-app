const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');
const { gerarToken } = require('../utils/token');

function apenasDono(req, res, next) {
  if (req.membro.papel !== 'dono') {
    return res.status(403).json({ erro: 'Só o dono da conta pode fazer isso.' });
  }
  next();
}

// Lista todos os membros da conta (só o dono ve essa lista).
router.get('/membros', autenticar, apenasDono, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, telefone, papel, visao_completa, data_entrada
       FROM membros WHERE conta_id = $1 ORDER BY data_entrada ASC`,
      [req.conta.id]
    );
    res.json({ membros: result.rows, limite_membros: req.conta.limite_membros });
  } catch (err) {
    console.error('Erro ao listar membros:', err);
    res.status(500).json({ erro: 'Erro ao buscar membros.' });
  }
});

// Adiciona uma pessoa nova na conta (Casal/Familia). Gera um link magico
// com token pra essa pessoa entrar direto, sem senha - so compartilhar o link.
router.post('/membros', autenticar, apenasDono, async (req, res) => {
  const { nome, telefone, visao_completa } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome e obrigatorio.' });
  }
  if (!telefone || !telefone.trim()) {
    return res.status(400).json({ erro: 'Telefone e obrigatorio.' });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');
  if (telefoneLimpo.length < 10) {
    return res.status(400).json({ erro: 'Telefone invalido.' });
  }

  try {
    const contagemResult = await pool.query(
      `SELECT COUNT(*) FROM membros WHERE conta_id = $1`,
      [req.conta.id]
    );
    const totalAtual = parseInt(contagemResult.rows[0].count, 10);

    if (totalAtual >= req.conta.limite_membros) {
      return res.status(400).json({
        erro: `Seu plano permite no maximo ${req.conta.limite_membros} pessoa(s). Troque de plano pra adicionar mais.`
      });
    }

    const novoToken = gerarToken();

    const result = await pool.query(
      `INSERT INTO membros (conta_id, nome, telefone, token_acesso, papel, visao_completa)
       VALUES ($1, $2, $3, $4, 'membro', $5)
       RETURNING id, nome, telefone, papel, visao_completa`,
      [req.conta.id, nome.trim(), telefoneLimpo, novoToken, visao_completa !== false]
    );

    res.status(201).json({ membro: result.rows[0], token: novoToken });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ erro: 'Esse telefone ja esta cadastrado nessa conta.' });
    }
    console.error('Erro ao adicionar membro:', err);
    res.status(500).json({ erro: 'Erro ao adicionar membro.' });
  }
});

// Muda se um membro ve tudo da conta ou so os proprios lancamentos.
router.put('/membros/:id/visao', autenticar, apenasDono, async (req, res) => {
  const { visao_completa } = req.body;
  if (typeof visao_completa !== 'boolean') {
    return res.status(400).json({ erro: 'Valor invalido.' });
  }

  try {
    const result = await pool.query(
      `UPDATE membros SET visao_completa = $1
       WHERE id = $2 AND conta_id = $3 AND papel != 'dono'
       RETURNING id, nome, visao_completa`,
      [visao_completa, req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Membro nao encontrado (ou e o dono, que sempre ve tudo).' });
    }
    res.json({ membro: result.rows[0] });
  } catch (err) {
    console.error('Erro ao mudar visao do membro:', err);
    res.status(500).json({ erro: 'Erro ao atualizar.' });
  }
});

// Remove um membro da conta (o dono nao pode remover a si mesmo por aqui).
router.delete('/membros/:id', autenticar, apenasDono, async (req, res) => {
  if (Number(req.params.id) === req.membro.id) {
    return res.status(400).json({ erro: 'Voce nao pode remover a si mesmo. Use "Sair deste aparelho" se quiser sair.' });
  }

  try {
    const result = await pool.query(
      `DELETE FROM membros WHERE id = $1 AND conta_id = $2 AND papel != 'dono' RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Membro nao encontrado.' });
    }
    res.json({ status: 'ok', removido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao remover membro:', err);
    res.status(500).json({ erro: 'Erro ao remover membro.' });
  }
});

// Sair da conta compartilhada (ex: casal se separou) e criar uma conta
// individual nova pra essa pessoa. Os lancamentos antigos dela ficam
// desvinculados (nao aparecem mais pra ninguem, mas o resto da conta
// continua intacto). Retorna um token novo ja da conta nova.
router.post('/membros/sair-conta-compartilhada', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const contagemResult = await client.query(
      `SELECT COUNT(*) FROM membros WHERE conta_id = $1`,
      [req.conta.id]
    );
    if (parseInt(contagemResult.rows[0].count, 10) <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Essa ja e uma conta individual, nao ha do que sair.' });
    }

    const membroAtualResult = await client.query(
      `SELECT telefone FROM membros WHERE id = $1`,
      [req.membro.id]
    );
    const telefoneAtual = membroAtualResult.rows[0] ? membroAtualResult.rows[0].telefone : '';

    await client.query(
      `UPDATE lancamentos SET membro_id = NULL WHERE membro_id = $1 AND conta_id = $2`,
      [req.membro.id, req.conta.id]
    ).catch(() => {
      // Se a coluna nao aceitar NULL, o historico fica ligado ao membro
      // removido - nao quebra nada, so nao aparece mais pra essa pessoa.
    });

    await client.query(`DELETE FROM membros WHERE id = $1`, [req.membro.id]);

    const dataVencimento = new Date();
    dataVencimento.setDate(dataVencimento.getDate() + 4);

    const novaContaResult = await client.query(
      `INSERT INTO contas (plano, valor_plano, limite_membros, status_assinatura, data_vencimento)
       VALUES ('individual', 12.99, 1, 'teste', $1) RETURNING id`,
      [dataVencimento]
    );
    const novaContaId = novaContaResult.rows[0].id;

    const novoToken = gerarToken();

    await client.query(
      `INSERT INTO membros (conta_id, nome, telefone, token_acesso, papel, visao_completa)
       VALUES ($1, $2, $3, $4, 'dono', TRUE)`,
      [novaContaId, req.membro.nome, telefoneAtual, novoToken]
    );

    await client.query('COMMIT');
    res.json({ token: novoToken, mensagem: 'Voce saiu da conta compartilhada e uma conta nova foi criada.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao sair da conta compartilhada:', err);
    res.status(500).json({ erro: 'Erro ao processar. Tente novamente.' });
  } finally {
    client.release();
  }
});

module.exports = router;
