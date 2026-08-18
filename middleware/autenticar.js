const pool = require('../db');

// Confere o token enviado (no header ou no corpo da requisicao) e anexa
// os dados do membro e da conta na requisicao, pra rotas protegidas usarem.
async function autenticar(req, res, next) {
  const token = req.headers['x-token'] || req.body.token || req.query.token;

  if (!token) {
    return res.status(401).json({ erro: 'Token nao informado.' });
  }

  try {
    const membroResult = await pool.query(
      `SELECT id, nome, papel, visao_completa, conta_id FROM membros WHERE token_acesso = $1`,
      [token]
    );

    if (membroResult.rows.length === 0) {
      return res.status(401).json({ erro: 'Token invalido.' });
    }

    const membro = membroResult.rows[0];

    const contaResult = await pool.query(
      `SELECT id, plano, valor_plano, limite_membros, status_assinatura, data_vencimento
       FROM contas WHERE id = $1`,
      [membro.conta_id]
    );

    if (contaResult.rows.length === 0) {
      return res.status(404).json({ erro: 'Conta nao encontrada.' });
    }

    const conta = contaResult.rows[0];

    // Mesmo com a assinatura vencida, a pessoa PRECISA conseguir escolher
    // o plano e gerar o Pix pra conseguir pagar e voltar a usar o app -
    // essas rotas ficam de fora do bloqueio.
    const ROTAS_PERMITIDAS_VENCIDO = ['/planos', '/cobranca/gerar', '/cobranca/status'];

    if (
      conta.status_assinatura === 'vencido' &&
      req.method !== 'GET' &&
      !ROTAS_PERMITIDAS_VENCIDO.includes(req.path)
    ) {
      return res.status(402).json({ erro: 'Assinatura vencida. Realize o pagamento pra continuar lancando.' });
    }

    req.membro = membro;
    req.conta = conta;
    next();
  } catch (err) {
    console.error('Erro na autenticacao:', err);
    res.status(500).json({ erro: 'Erro ao autenticar. Tente novamente.' });
  }
}

module.exports = autenticar;
