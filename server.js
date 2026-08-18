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

async function iniciar() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Meu Bolso rodando na porta ${PORT}`);
    });
    cron.schedule('0 6 * * *', verificarVencimentos); // todo dia as 6h
    verificarVencimentos(); // roda uma vez ja na largada tambem
  } catch (err) {
    console.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  }
}

iniciar();
