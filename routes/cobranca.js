const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const NOMES_PLANO = { individual: 'Individual', casal: 'Casal', familia: 'Família' };

const URL_BASE = 'https://meu-bolso-app-production.up.railway.app';

let paymentClient = null;
function getPaymentClient() {
  if (!process.env.MP_ACCESS_TOKEN) return null;
  if (!paymentClient) {
    const client = new MercadoPagoConfig({
      accessToken: process.env.MP_ACCESS_TOKEN,
      options: { timeout: 8000 }
    });
    paymentClient = new Payment(client);
  }
  return paymentClient;
}

function apenasDono(req, res, next) {
  if (req.membro.papel !== 'dono') {
    return res.status(403).json({ erro: 'Só o dono da conta pode fazer isso.' });
  }
  next();
}

// Soma 1 mes (ou 1 ano, se a conta for anual) a partir da maior data entre
// "agora" e o vencimento atual - assim quem paga adiantado nao perde os dias
// que ainda tinha de assinatura.
function calcularProximoVencimento(dataVencimentoAtual, periodicidade) {
  const agora = new Date();
  const base = dataVencimentoAtual && new Date(dataVencimentoAtual) > agora
    ? new Date(dataVencimentoAtual)
    : agora;
  const resultado = new Date(base);
  if (periodicidade === 'anual') {
    resultado.setFullYear(resultado.getFullYear() + 1);
  } else {
    resultado.setMonth(resultado.getMonth() + 1);
  }
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

  const novoVencimento = calcularProximoVencimento(conta.data_vencimento, conta.periodicidade);

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
  const client = getPaymentClient();
  if (!client) {
    return res.status(500).json({ erro: 'Pagamento nao configurado. Fale com o suporte.' });
  }

  try {
    // Se ja tem uma cobranca pendente de menos de 25 minutos, confere com o
    // Mercado Pago se ela ja foi paga antes de simplesmente devolver o QR
    // antigo - evita mostrar "pendente" pra quem ja pagou (ex: pagou e o
    // webhook atrasou, ou a pessoa fechou o app e abriu de novo depois).
    const pendenteResult = await pool.query(
      `SELECT * FROM cobrancas
       WHERE conta_id = $1 AND status = 'pendente' AND data_criacao > NOW() - INTERVAL '25 minutes'
       ORDER BY data_criacao DESC LIMIT 1`,
      [req.conta.id]
    );
    if (pendenteResult.rows.length > 0) {
      const c = pendenteResult.rows[0];
      let cobrancaAntigaValida = true;

      if (c.mp_payment_id) {
        try {
          const consulta = await client.get({ id: c.mp_payment_id });
          if (consulta.status === 'approved') {
            await confirmarPagamento(c.mp_payment_id);
            return res.json({ ja_pago: true });
          }
          // ainda pendente de verdade no Mercado Pago - o QR antigo continua valendo
        } catch (erroConsulta) {
          // nao deu pra confirmar que essa cobranca antiga ainda existe/e valida
          // (id de teste, expirou, etc) - marca como invalida e gera uma nova abaixo
          console.error('Cobranca antiga invalida, gerando nova:', erroConsulta.message);
          cobrancaAntigaValida = false;
          await pool.query(`UPDATE cobrancas SET status = 'invalida' WHERE id = $1`, [c.id]);
        }
      }

      if (cobrancaAntigaValida) {
        return res.json({ qr_code: c.qr_code, qr_code_base64: c.qr_code_base64, valor: c.valor });
      }
    }

    const membroResult = await pool.query(`SELECT telefone FROM membros WHERE id = $1`, [req.membro.id]);
    const telefone = membroResult.rows[0] ? membroResult.rows[0].telefone : '00000000000';
    // O e-mail precisa ser UNICO a cada tentativa - nunca repetir o mesmo
    // e-mail sintetico varias vezes seguidas, senao o Mercado Pago bloqueia
    // com PA_UNAUTHORIZED_RESULT_FROM_POLICIES (antifraude por padrao repetido).
    const emailSintetico = `pix${telefone}${Date.now()}@meubolso.app`;

    const nomePlano = NOMES_PLANO[req.conta.plano] || req.conta.plano;
    const rotuloPeriodo = req.conta.periodicidade === 'anual' ? 'anual' : 'mensal';

    let resposta;
    try {
      resposta = await client.create({
        body: {
          transaction_amount: Number(req.conta.valor_plano),
          description: `Meu Bolso - Plano ${nomePlano} (${rotuloPeriodo})`,
          payment_method_id: 'pix',
          external_reference: String(req.conta.id),
          notification_url: `${URL_BASE}/api/cobranca/webhook`,
          payer: { email: emailSintetico, first_name: req.membro.nome || 'Cliente' }
        }
      });
    } catch (erroMp) {
      console.error('Erro do Mercado Pago ao criar pagamento:', erroMp.message, erroMp.cause || '');
      return res.status(502).json({ erro: 'Nao foi possivel gerar o Pix agora. Tente novamente em instantes.' });
    }

    const dadosPix = resposta.point_of_interaction?.transaction_data;
    if (!dadosPix) {
      console.error('Resposta do Mercado Pago sem dados de Pix:', resposta);
      return res.status(502).json({ erro: 'Nao foi possivel gerar o Pix agora. Tente novamente em instantes.' });
    }

    const qrCode = dadosPix.qr_code;
    const qrCodeBase64 = dadosPix.qr_code_base64;

    await pool.query(
      `INSERT INTO cobrancas (conta_id, mp_payment_id, valor, status, qr_code, qr_code_base64)
       VALUES ($1, $2, $3, 'pendente', $4, $5)`,
      [req.conta.id, String(resposta.id), req.conta.valor_plano, qrCode, qrCodeBase64]
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
    const client = getPaymentClient();

    // Se a ultima cobranca ainda ta pendente, confere direto com o Mercado Pago
    // (cobre o caso raro do webhook atrasar ou nao chegar).
    if (cobranca && cobranca.status === 'pendente' && cobranca.mp_payment_id && client) {
      try {
        const consulta = await client.get({ id: cobranca.mp_payment_id });
        if (consulta.status === 'approved') {
          await confirmarPagamento(cobranca.mp_payment_id);
        }
      } catch (erroConsulta) {
        console.error('Erro ao consultar pagamento no Mercado Pago:', erroConsulta.message);
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
    const client = getPaymentClient();
    if (!paymentId || !client) {
      return res.sendStatus(200); // responde OK mesmo assim pra nao gerar retentativa infinita
    }

    try {
      const consulta = await client.get({ id: paymentId });
      if (consulta.status === 'approved') {
        await confirmarPagamento(paymentId);
      }
    } catch (erroConsulta) {
      console.error('Erro ao consultar pagamento no webhook:', erroConsulta.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook de cobranca:', err);
    res.sendStatus(200); // sempre responde 200 pro Mercado Pago nao ficar retentando
  }
});

module.exports = router;
