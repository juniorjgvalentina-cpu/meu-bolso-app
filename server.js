require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const initDb = require('./initDb');
const pool = require('./db');
const { proximoCicloFatura, dataFechamentoDoCiclo } = require('./utils/faturaCartao');

const cadastroRoutes = require('./routes/cadastro');
const loginRoutes = require('./routes/login');
const itensRoutes = require('./routes/itens');
const cartoesRoutes = require('./routes/cartoes');
const lancamentosRoutes = require('./routes/lancamentos');
const pendenciasRoutes = require('./routes/pendencias');
const analiseRoutes = require('./routes/analise');
const relatorioRoutes = require('./routes/relatorio');
const dadosRoutes = require('./routes/dados');
const membrosRoutes = require('./routes/membros');
const planosRoutes = require('./routes/planos');
const cobrancaRoutes = require('./routes/cobranca');
const masterRoutes = require('./routes/master');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', cadastroRoutes);
app.use('/api', loginRoutes);
app.use('/api', itensRoutes);
app.use('/api', cartoesRoutes);
app.use('/api', lancamentosRoutes);
app.use('/api', pendenciasRoutes);
app.use('/api', analiseRoutes);
app.use('/api', relatorioRoutes);
app.use('/api', dadosRoutes);
app.use('/api', membrosRoutes);
app.use('/api', planosRoutes);
app.use('/api', cobrancaRoutes);
app.use('/api', masterRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function verificarVencimentos() {
  try {
    const result = await pool.query(
      `UPDATE contas SET status_assinatura = 'vencido'
       WHERE status_assinatura != 'vencido' AND data_vencimento IS NOT NULL AND data_vencimento < NOW()
       RETURNING id`
    );
    if (result.rows.length > 0) {
      console.log(`Job de vencimento: ${result.rows.length} conta(s) marcada(s) como vencida(s).`);
    }
  } catch (err) {
    console.error('Erro no job de verificar vencimentos:', err);
  }
}

function somarMesesData(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

// Pendencias comuns (nao de cartao): a partir de agora disparam assim que o
// MES vira (nao precisa esperar o dia exato vencer) - ex: luz vence dia 15,
// mas assim que entra um mes novo (dia 1), a pendencia desse mes ja aparece
// como lembrete, mesmo a do mes anterior ainda nao tendo sido paga. As duas
// ficam visiveis ate a antiga ser resolvida.
async function gerarProximasPendenciasComuns() {
  let geradas = 0;
  for (let i = 0; i < 36; i++) {
    const candidatos = await pool.query(`
      SELECT p.* FROM contas_pendentes p
      WHERE p.recorrente = TRUE
        AND p.resolvido = FALSE
        AND p.cartao_id IS NULL
        AND date_trunc('month', p.data_vencimento) < date_trunc('month', CURRENT_DATE)
        AND NOT EXISTS (
          SELECT 1 FROM contas_pendentes p2
          WHERE p2.conta_id = p.conta_id
            AND p2.tipo = p.tipo
            AND p2.nome = p.nome
            AND p2.recorrente = TRUE
            AND p2.data_vencimento > p.data_vencimento
        )
    `);
    if (candidatos.rows.length === 0) break;

    for (const p of candidatos.rows) {
      const atingiuLimite = p.total_ocorrencias && p.ocorrencia_atual >= p.total_ocorrencias;
      if (atingiuLimite) continue;

      const proximaData = somarMesesData(new Date(p.data_vencimento), 1).toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, valor, data_vencimento, recorrente, total_ocorrencias, ocorrencia_atual)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8)`,
        [p.conta_id, p.membro_id, p.tipo, p.nome, p.valor, proximaData, p.total_ocorrencias, (p.ocorrencia_atual || 1) + 1]
      );
      geradas++;
    }
  }
  return geradas;
}

// Faturas de cartao: disparam quando a fatura FECHA (nao quando vence).
// Isso abre a proxima fatura, ja pronta pra receber lancamentos novos,
// enquanto a fatura anterior (ja fechada) continua separada esperando
// pagamento - as duas ficam visiveis ao mesmo tempo em A Pagar.
async function gerarProximasFaturasDeCartao() {
  let geradas = 0;
  const pendentes = await pool.query(`
    SELECT p.*, c.dia_fechamento, c.dia_vencimento
    FROM contas_pendentes p
    JOIN cartoes c ON c.id = p.cartao_id
    WHERE p.recorrente = TRUE AND p.resolvido = FALSE AND p.cartao_id IS NOT NULL
      AND p.fatura_referencia IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM contas_pendentes p2
        WHERE p2.cartao_id = p.cartao_id AND p2.recorrente = TRUE
          AND p2.fatura_referencia > p.fatura_referencia
      )
  `);

  for (const p of pendentes.rows) {
    const fechamentoCiclo = dataFechamentoDoCiclo(p.fatura_referencia, p.dia_fechamento, p.dia_vencimento);
    const abreEm = new Date(`${fechamentoCiclo}T00:00:00`);
    abreEm.setDate(abreEm.getDate() + 1);

    if (abreEm <= new Date()) {
      const proximo = proximoCicloFatura(p.fatura_referencia, p.dia_vencimento);
      await pool.query(
        `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, data_vencimento, recorrente, cartao_id, fatura_referencia)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)`,
        [p.conta_id, p.membro_id, p.tipo, p.nome, proximo.dataVencimento, p.cartao_id, proximo.referencia]
      );
      geradas++;
    }
  }
  return geradas;
}

async function gerarProximasPendenciasRecorrentes() {
  try {
    const geradasComuns = await gerarProximasPendenciasComuns();
    const geradasCartao = await gerarProximasFaturasDeCartao();
    const total = geradasComuns + geradasCartao;
    if (total > 0) {
      console.log(`Job de recorrencia: ${total} pendencia(s) gerada(s) (${geradasComuns} comuns, ${geradasCartao} de cartao).`);
    }
  } catch (err) {
    console.error('Erro no job de gerar recorrentes:', err);
  }
}

async function iniciar() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Meu Bolso rodando na porta ${PORT}`);
    });
    cron.schedule('0 6 * * *', verificarVencimentos);
    cron.schedule('5 6 * * *', gerarProximasPendenciasRecorrentes);
    verificarVencimentos();
    gerarProximasPendenciasRecorrentes();
  } catch (err) {
    console.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  }
}

iniciar();
