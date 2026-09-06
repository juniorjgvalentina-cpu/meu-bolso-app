const pool = require('./db');

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS contas (
        id SERIAL PRIMARY KEY,
        plano VARCHAR(20) NOT NULL DEFAULT 'individual',
        periodicidade VARCHAR(10) NOT NULL DEFAULT 'mensal',
        valor_plano NUMERIC(6,2) NOT NULL DEFAULT 12.99,
        limite_membros INTEGER NOT NULL DEFAULT 1,
        status_assinatura VARCHAR(20) NOT NULL DEFAULT 'teste',
        data_cadastro TIMESTAMP NOT NULL DEFAULT NOW(),
        data_vencimento TIMESTAMP,
        ultima_cobranca TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE contas ADD COLUMN IF NOT EXISTS periodicidade VARCHAR(10) NOT NULL DEFAULT 'mensal';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS membros (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        nome VARCHAR(120) NOT NULL,
        telefone VARCHAR(20) NOT NULL,
        token_acesso VARCHAR(64) NOT NULL UNIQUE,
        papel VARCHAR(10) NOT NULL DEFAULT 'dono',
        visao_completa BOOLEAN NOT NULL DEFAULT TRUE,
        data_entrada TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (conta_id, telefone)
      );
    `);

    await client.query(`
      ALTER TABLE membros ADD COLUMN IF NOT EXISTS visao_completa BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS itens_conhecidos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        nome_item VARCHAR(120) NOT NULL,
        nome_item_normalizado VARCHAR(120) NOT NULL,
        tipo VARCHAR(15) NOT NULL,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (conta_id, nome_item_normalizado)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cartoes (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        nome VARCHAR(60) NOT NULL,
        dia_vencimento INTEGER NOT NULL,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE cartoes ADD COLUMN IF NOT EXISTS dia_fechamento INTEGER NOT NULL DEFAULT 1;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lancamentos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        membro_id INTEGER NOT NULL REFERENCES membros(id) ON DELETE CASCADE,
        descricao VARCHAR(120) NOT NULL,
        observacao VARCHAR(200),
        valor NUMERIC(10,2) NOT NULL,
        tipo_movimento VARCHAR(10) NOT NULL,
        categoria VARCHAR(15),
        forma_pagamento VARCHAR(10),
        parcela_atual INTEGER,
        total_parcelas INTEGER,
        grupo_parcela_id UUID,
        data_lancamento TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS observacao VARCHAR(200);
    `);

    await client.query(`
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS fatura_paga BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS cartao_id INTEGER REFERENCES cartoes(id) ON DELETE SET NULL;
    `);

    await client.query(`
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS fatura_paga_em TIMESTAMP;
    `);

    await client.query(`
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS fatura_referencia VARCHAR(7);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        valor_meta_economia NUMERIC(10,2) NOT NULL,
        mes_referencia VARCHAR(7) NOT NULL,
        UNIQUE (conta_id, mes_referencia)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orcamentos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        categoria VARCHAR(15) NOT NULL,
        valor_teto NUMERIC(10,2) NOT NULL,
        mes_referencia VARCHAR(7) NOT NULL,
        UNIQUE (conta_id, categoria, mes_referencia)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contas_pendentes (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        membro_id INTEGER REFERENCES membros(id) ON DELETE SET NULL,
        tipo VARCHAR(10) NOT NULL,
        nome VARCHAR(120) NOT NULL,
        valor NUMERIC(10,2),
        data_vencimento DATE NOT NULL,
        resolvido BOOLEAN NOT NULL DEFAULT FALSE,
        data_resolucao TIMESTAMP,
        lancamento_id INTEGER REFERENCES lancamentos(id) ON DELETE SET NULL,
        recorrente BOOLEAN NOT NULL DEFAULT FALSE,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE contas_pendentes ADD COLUMN IF NOT EXISTS recorrente BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE contas_pendentes ADD COLUMN IF NOT EXISTS cartao_id INTEGER REFERENCES cartoes(id) ON DELETE CASCADE;
    `);

    await client.query(`
      ALTER TABLE contas_pendentes ADD COLUMN IF NOT EXISTS total_ocorrencias INTEGER;
    `);
    await client.query(`
      ALTER TABLE contas_pendentes ADD COLUMN IF NOT EXISTS ocorrencia_atual INTEGER NOT NULL DEFAULT 1;
    `);

    await client.query(`
      ALTER TABLE contas_pendentes ADD COLUMN IF NOT EXISTS fatura_referencia VARCHAR(7);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cobrancas (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        mp_payment_id VARCHAR(40),
        valor NUMERIC(6,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pendente',
        qr_code TEXT,
        qr_code_base64 TEXT,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW(),
        data_pagamento TIMESTAMP
      );
    `);

    await client.query('COMMIT');
    console.log('initDb: tabelas verificadas/criadas com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('initDb: erro ao criar tabelas:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = initDb;
