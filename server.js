require('dotenv').config();
const express = require('express');
const path = require('path');
const initDb = require('./initDb');

const cadastroRoutes = require('./routes/cadastro');
const loginRoutes = require('./routes/login');
const itensRoutes = require('./routes/itens');
const lancamentosRoutes = require('./routes/lancamentos');
const pendenciasRoutes = require('./routes/pendencias');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', cadastroRoutes);
app.use('/api', loginRoutes);
app.use('/api', itensRoutes);
app.use('/api', lancamentosRoutes);
app.use('/api', pendenciasRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function iniciar() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Meu Bolso rodando na porta ${PORT}`);
    });
  } catch (err) {
    console.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  }
}

iniciar();
