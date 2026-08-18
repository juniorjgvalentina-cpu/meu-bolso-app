const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const MP_API = 'https://api.mercadopago.com/v1/payments';

const NOMES_PLANO = { individual: 'Individual', casal: 'Casal', familia: 'Família' };

function apenasDono(req, res, next) {
  if (req.membro.papel !== 'dono') {
    return res.status(403).json({ erro: 'Só o dono da conta pode fazer isso.' });
  }
  next();
}

// Soma 1 mes a partir da maior data entre "agora" e o vencimento atual -
// assim quem paga adiantado nao perde os dias que ainda tinha de assinatura.
function calcularProximoVencimento(dataVencimentoAtual) {
  const agora = new Date();
  const base = dataVencimentoAtual && new Date(dataVencimentoAtual) > agora
    ? new Date(dataVencimentoAtual)
    : agora;
  const resultado = new Date(base);
  resultado.setMonth(resultado.getMonth() + 1);
  return resultado;
}

// Marca a cobranca como paga e libera a conta por mais 1 mes.
async function confirmarPagamento(mpPaymentId) {
  const cobrancaResult = await pool.query(
    `SELECT * FROM cobrancas WHERE mp_payment_id = $1`,
    [String(mpPaymentId)]
  );
  if (cobrancaResult.rows.length === 0) return;

  const cobranca = cobrancaResult.rows[0];
  if (cobranca.status === 'pago') return; // ja processado, evita duplicar

  const contaResult = await pool.query(`SELECT * FROM contas WHERE id = $1`, [cobranca.conta_id]);
  if (contaResult.rows.length === 0) return;
  const conta = contaResult.rows[0];

  const novoVencimento = calcularProximoVencimento(conta.data_vencimento);

  await pool.query(
    `UPDATE cobrancas SET status = 'pago', data_pagamento = NOW() WHERE id = $1`,
    [cobranca.id]
  );
  await pool.query(
    `UPDATE contas SET status_assinatura = 'ativo', data_vencimento = $1, ultima_cobranca = NOW() WHERE id = $2`,
    [novoVencimento, conta.id]
  );
}

// Gera uma cobranca Pix nova (ou devolve a pendente recente, se ja existir uma).
router.post('/cobranca/gerar', autenticar, apenasDono, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ erro: 'Pagamento nao configurado. Fale com o suporte.' });
  }

  try {
    // Se ja tem uma cobranca pendente de menos de 25 minutos, reaproveita
    // (o Pix do Mercado Pago costuma expirar em 30 min).
    const pendenteResult = await pool.query(
      `SELECT * FROM cobrancas
       WHERE conta_id = $1 AND status = 'pendente' AND data_criacao > NOW() - INTERVAL '25 minutes'
       ORDER BY data_criacao DESC LIMIT 1`,
      [req.conta.id]
    );
    if (pendenteResult.rows.length > 0) {
      const c = pendenteResult.rows[0];
      return res.json({ qr_code: c.qr_code, qr_code_base64: c.qr_code_base64, valor: c.valor });
    }

    const membroResult = await pool.query(`SELECT telefone FROM membros WHERE id = $1`, [req.membro.id]);
    const telefone = membroResult.rows[0] ? membroResult.rows[0].telefone : '00000000000';
    const emailSintetico = `pix${telefone}@meubolso.app`;

    const nomePlano = NOMES_PLANO[req.conta.plano] || req.conta.plano;

    const mpResponse = await fetch(MP_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': randomUUID()
      },
      body: JSON.stringify({
        transaction_amount: Number(req.conta.valor_plano),
        description: `Meu Bolso - Plano ${nomePlano}`,
        payment_method_id: 'pix',
        payer: { email: emailSintetico, first_name: req.membro.nome || 'Cliente' }
      })
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok || !mpData.point_of_interaction) {
      console.error('Erro do Mercado Pago:', mpData);
      return res.status(502).json({ erro: 'Nao foi possivel gerar o Pix agora. Tente novamente em instantes.' });
    }

    const qrCode = mpData.point_of_interaction.transaction_data.qr_code;
    const qrCodeBase64 = mpData.point_of_interaction.transaction_data.qr_code_base64;

    await pool.query(
      `INSERT INTO cobrancas (conta_id, mp_payment_id, valor, status, qr_code, qr_code_base64)
       VALUES ($1, $2, $3, 'pendente', $4, $5)`,
      [req.conta.id, String(mpData.id), req.conta.valor_plano, qrCode, qrCodeBase64]
    );

    res.json({ qr_code: qrCode, qr_code_base64: qrCodeBase64, valor: req.conta.valor_plano });
  } catch (err) {
    console.error('Erro ao gerar cobranca:', err);
    res.status(500).json({ erro: 'Erro ao gerar cobranca. Tente novamente.' });
  }
});

// A tela de cobranca fica consultando esse endpoint pra saber se ja pagou
// (funciona junto com o webhook - o webhook e mais rapido, isso e um reforco).
router.get('/cobranca/status', autenticar, async (req, res) => {
  try {
    const cobrancaResult = await pool.query(
      `SELECT * FROM cobrancas WHERE conta_id = $1 ORDER BY data_criacao DESC LIMIT 1`,
      [req.conta.id]
    );
    const cobranca = cobrancaResult.rows[0];

    // Se a ultima cobranca ainda ta pendente, confere direto com o Mercado Pago
    // (cobre o caso raro do webhook atrasar ou nao chegar).
    if (cobranca && cobranca.status === 'pendente' && cobranca.mp_payment_id && process.env.MP_ACCESS_TOKEN) {
      const mpResponse = await fetch(`${MP_API}/${cobranca.mp_payment_id}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const mpData = await mpResponse.json();
      if (mpResponse.ok && mpData.status === 'approved') {
        await confirmarPagamento(cobranca.mp_payment_id);
      }
    }

    const contaResult = await pool.query(`SELECT status_assinatura, data_vencimento FROM contas WHERE id = $1`, [req.conta.id]);
    res.json({
      status_assinatura: contaResult.rows[0].status_assinatura,
      data_vencimento: contaResult.rows[0].data_vencimento
    });
  } catch (err) {
    console.error('Erro ao consultar status:', err);
    res.status(500).json({ erro: 'Erro ao consultar status.' });
  }
});

// Webhook publico - o Mercado Pago chama essa rota quando o status de um
// pagamento muda. Nao passa pelo middleware de autenticar (nao tem token).
router.post('/cobranca/webhook', async (req, res) => {
  try {
    const paymentId = req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || req.query.id;
    if (!paymentId || !process.env.MP_ACCESS_TOKEN) {
      return res.sendStatus(200); // responde OK mesmo assim pra nao gerar retentativa infinita
    }

    const mpResponse = await fetch(`${MP_API}/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const mpData = await mpResponse.json();

    if (mpResponse.ok && mpData.status === 'approved') {
      await confirmarPagamento(paymentId);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook de cobranca:', err);
    res.sendStatus(200); // sempre responde 200 pro Mercado Pago nao ficar retentando
  }
});

module.exports = router;
