const express = require('express');
const router = express.Router();
const pool = require('../db');

const NOMES_PLANO = { individual: 'Individual', casal: 'Casal', familia: 'Família' };

// Autenticacao simples: compara usuario/senha enviados em header com as
// variaveis de ambiente ADMIN_USER/ADMIN_PASS. Sem sessao/token - o painel
// manda esses dois headers em toda chamada (guardados no localStorage do
// navegador, so nesse aparelho).
function autenticarMaster(req, res, next) {
  const usuario = req.headers['x-master-user'];
  const senha = req.headers['x-master-pass'];

  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(500).json({ erro: 'Painel nao configurado no servidor.' });
  }
  if (usuario !== process.env.ADMIN_USER || senha !== process.env.ADMIN_PASS) {
    return res.status(401).json({ erro: 'Usuario ou senha invalidos.' });
  }
  next();
}

router.post('/master/login', (req, res) => {
  const { usuario, senha } = req.body;
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(500).json({ erro: 'Painel nao configurado no servidor.' });
  }
  if (usuario !== process.env.ADMIN_USER || senha !== process.env.ADMIN_PASS) {
    return res.status(401).json({ erro: 'Usuario ou senha invalidos.' });
  }
  res.json({ status: 'ok' });
});

// Resumo geral: quantidade de contas por status/plano e receita mensal
// recorrente estimada (MRR) - planos anuais entram divididos por 12.
router.get('/master/resumo', autenticarMaster, async (req, res) => {
  try {
    const contasResult = await pool.query(
      `SELECT plano, periodicidade, valor_plano, status_assinatura FROM contas`
    );
    const contas = contasResult.rows;

    const resumo = {
      total_contas: contas.length,
      por_status: { teste: 0, ativo: 0, vencido: 0 },
      por_plano: { individual: 0, casal: 0, familia: 0 },
      mrr: 0
    };

    contas.forEach(c => {
      if (resumo.por_status[c.status_assinatura] !== undefined) {
        resumo.por_status[c.status_assinatura]++;
      }
      if (resumo.por_plano[c.plano] !== undefined) {
        resumo.por_plano[c.plano]++;
      }
      if (c.status_assinatura === 'ativo') {
        const valorMensal = c.periodicidade === 'anual' ? Number(c.valor_plano) / 12 : Number(c.valor_plano);
        resumo.mrr += valorMensal;
      }
    });

    const membrosResult = await pool.query(`SELECT COUNT(*) FROM membros`);
    resumo.total_membros = parseInt(membrosResult.rows[0].count, 10);

    res.json(resumo);
  } catch (err) {
    console.error('Erro ao buscar resumo master:', err);
    res.status(500).json({ erro: 'Erro ao buscar resumo.' });
  }
});

// Lista todas as contas com o dono de cada uma. Aceita busca por nome/telefone.
router.get('/master/contas', autenticarMaster, async (req, res) => {
  const busca = (req.query.busca || '').trim();

  try {
    let query = `
      SELECT c.id, c.plano, c.periodicidade, c.valor_plano, c.status_assinatura,
             c.data_cadastro, c.data_vencimento, c.ultima_cobranca,
             m.nome AS dono_nome, m.telefone AS dono_telefone,
             (SELECT COUNT(*) FROM membros WHERE conta_id = c.id) AS total_membros
      FROM contas c
      LEFT JOIN membros m ON m.conta_id = c.id AND m.papel = 'dono'
    `;
    const params = [];
    if (busca) {
      query += ` WHERE m.nome ILIKE $1 OR m.telefone ILIKE $1`;
      params.push(`%${busca}%`);
    }
    query += ` ORDER BY c.data_cadastro DESC`;

    const result = await pool.query(query, params);
    res.json({ contas: result.rows, nomes_plano: NOMES_PLANO });
  } catch (err) {
    console.error('Erro ao listar contas master:', err);
    res.status(500).json({ erro: 'Erro ao buscar contas.' });
  }
});

// Marca uma conta como paga manualmente (ex: cliente pagou por fora, Pix
// direto pra chave do Juca) - estende o vencimento pelo ciclo normal do plano.
router.put('/master/contas/:id/marcar-pago', autenticarMaster, async (req, res) => {
  try {
    const contaResult = await pool.query(`SELECT * FROM contas WHERE id = $1`, [req.params.id]);
    if (contaResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Conta nao encontrada.' });
    }
    const conta = contaResult.rows[0];

    const agora = new Date();
    const base = conta.data_vencimento && new Date(conta.data_vencimento) > agora
      ? new Date(conta.data_vencimento)
      : agora;
    const novoVencimento = new Date(base);
    if (conta.periodicidade === 'anual') {
      novoVencimento.setFullYear(novoVencimento.getFullYear() + 1);
    } else {
      novoVencimento.setMonth(novoVencimento.getMonth() + 1);
    }

    await pool.query(
      `UPDATE contas SET status_assinatura = 'ativo', data_vencimento = $1, ultima_cobranca = NOW() WHERE id = $2`,
      [novoVencimento, req.params.id]
    );

    res.json({ status: 'ok', novo_vencimento: novoVencimento });
  } catch (err) {
    console.error('Erro ao marcar como pago:', err);
    res.status(500).json({ erro: 'Erro ao marcar como pago.' });
  }
});

// Concede acesso gratis por X dias (ex: cortesia, teste estendido).
router.put('/master/contas/:id/conceder-acesso', autenticarMaster, async (req, res) => {
  const dias = parseInt(req.body.dias, 10);
  if (!dias || dias <= 0 || dias > 365) {
    return res.status(400).json({ erro: 'Numero de dias invalido.' });
  }

  try {
    const contaResult = await pool.query(`SELECT * FROM contas WHERE id = $1`, [req.params.id]);
    if (contaResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Conta nao encontrada.' });
    }
    const conta = contaResult.rows[0];

    const agora = new Date();
    const base = conta.data_vencimento && new Date(conta.data_vencimento) > agora
      ? new Date(conta.data_vencimento)
      : agora;
    const novoVencimento = new Date(base);
    novoVencimento.setDate(novoVencimento.getDate() + dias);

    await pool.query(
      `UPDATE contas SET status_assinatura = 'ativo', data_vencimento = $1 WHERE id = $2`,
      [novoVencimento, req.params.id]
    );

    res.json({ status: 'ok', novo_vencimento: novoVencimento });
  } catch (err) {
    console.error('Erro ao conceder acesso:', err);
    res.status(500).json({ erro: 'Erro ao conceder acesso.' });
  }
});

module.exports = router;
