require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const initDb = require('./initDb');
const pool = require('./db');

const cadastroRoutes = require('./routes/cadastro');
const loginRoutes = require('./routes/login');
const itensRoutes = require('./routes/itens');
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

// Job diario: marca como 'vencido' toda conta cuja data_vencimento ja passou
// e ainda nao foi marcada. O middleware ja faz essa checagem na hora do login,
// mas esse job garante que o status fique correto mesmo pra contas que ninguem
// abriu o app naquele dia.
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

// Soma meses a uma data, ajustando pro ultimo dia do mes quando o dia
// original nao existir no mes seguinte (ex: 31 de janeiro + 1 mes = 28/29 fevereiro).
function somarMesesData(data, meses) {
  const resultado = new Date(data);
  const diaOriginal = resultado.getDate();
  resultado.setDate(1);
  resultado.setMonth(resultado.getMonth() + meses);
  const ultimoDiaDoMes = new Date(resultado.getFullYear(), resultado.getMonth() + 1, 0).getDate();
  resultado.setDate(Math.min(diaOriginal, ultimoDiaDoMes));
  return resultado;
}

// Job diario: gera a proxima ocorrencia de pendencias recorrentes que venceram
// e ainda nao foram pagas - SEM apagar a atrasada. Assim, se a pessoa atrasar
// 3 meses, ela ve as 3 pendencias empilhadas, cada uma na sua data certa.
async function gerarProximasPendenciasRecorrentes() {
  try {
    let geradas = 0;
    for (let i = 0; i < 36; i++) {
      const candidatos = await pool.query(`
        SELECT p.* FROM contas_pendentes p
        WHERE p.recorrente = TRUE
          AND p.resolvido = FALSE
          AND p.data_vencimento < CURRENT_DATE
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
        const proximaData = somarMesesData(new Date(p.data_vencimento), 1);
        await pool.query(
          `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, valor, data_vencimento, recorrente)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [p.conta_id, p.membro_id, p.tipo, p.nome, p.valor, proximaData]
        );
        geradas++;
      }
    }
    if (geradas > 0) {
      console.log(`Job de recorrencia: ${geradas} pendencia(s) gerada(s).`);
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
    cron.schedule('0 6 * * *', verificarVencimentos); // todo dia as 6h
    cron.schedule('5 6 * * *', gerarProximasPendenciasRecorrentes); // todo dia as 6h05
    verificarVencimentos(); // roda uma vez ja na largada tambem
    gerarProximasPendenciasRecorrentes();
  } catch (err) {
    console.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  }
}

iniciar();
