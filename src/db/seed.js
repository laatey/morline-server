export const DEFAULT_REGIONS = [
  { id: 'us-east', name: 'US East (N. Virginia)', countryCode: 'US', available: true },
  { id: 'us-west', name: 'US West (Oregon)', countryCode: 'US', available: true },
  { id: 'eu-west', name: 'Europe West (Ireland)', countryCode: 'EU', available: true },
  { id: 'eu-central', name: 'Europe Central (Frankfurt)', countryCode: 'DE', available: true },
  { id: 'ap-southeast', name: 'Asia Pacific (Singapore)', countryCode: 'SG', available: true }
];

export const DEFAULT_TEMPLATES = [
  {
    id: 'postgres',
    name: 'PostgreSQL',
    logo: 'postgres',
    kind: 'database',
    group: 'Databases',
    hint: 'Relational database with persistent volume',
    inputs: [
      { key: 'POSTGRES_DB', label: 'Database Name', type: 'string', required: true, default: 'moorline' },
      { key: 'POSTGRES_USER', label: 'User', type: 'string', required: true, default: 'postgres' },
      { key: 'POSTGRES_PASSWORD', label: 'Password', type: 'secret', required: true, default: 'postgres' }
    ]
  },
  {
    id: 'redis',
    name: 'Redis',
    logo: 'redis',
    kind: 'database',
    group: 'Databases',
    hint: 'In-memory key-value cache and message broker',
    inputs: [
      { key: 'REDIS_PASSWORD', label: 'Password', type: 'secret', required: false, default: '' }
    ]
  },
  {
    id: 'mysql',
    name: 'MySQL',
    logo: 'mysql',
    kind: 'database',
    group: 'Databases',
    hint: 'Open-source relational database',
    inputs: [
      { key: 'MYSQL_DATABASE', label: 'Database Name', type: 'string', required: true, default: 'moorline' },
      { key: 'MYSQL_USER', label: 'User', type: 'string', required: true, default: 'moorline' },
      { key: 'MYSQL_PASSWORD', label: 'Password', type: 'secret', required: true, default: 'moorline' }
    ]
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    logo: 'mongodb',
    kind: 'database',
    group: 'Databases',
    hint: 'Document database for modern apps',
    inputs: [
      { key: 'MONGO_INITDB_DATABASE', label: 'Database Name', type: 'string', required: true, default: 'moorline' }
    ]
  },
  {
    id: 'sqlite',
    name: 'SQLite API',
    logo: 'sqlite',
    kind: 'database',
    group: 'Databases',
    hint: 'Embedded serverless database service',
    inputs: []
  },
  {
    id: 'js',
    name: 'Node.js Express',
    logo: 'js',
    kind: 'app',
    group: 'Starters',
    hint: 'Minimalist HTTP web service',
    inputs: [
      { key: 'PORT', label: 'Port', type: 'number', required: false, default: 3000 }
    ]
  },
  {
    id: 'nextjs',
    name: 'Next.js App',
    logo: 'nextjs',
    kind: 'app',
    group: 'Starters',
    hint: 'React framework for the web',
    inputs: [
      { key: 'NODE_ENV', label: 'Environment', type: 'string', required: true, default: 'production' }
    ]
  },
  {
    id: 'vite',
    name: 'Vite React Frontend',
    logo: 'vite',
    kind: 'app',
    group: 'Starters',
    hint: 'Lightning fast frontend SPA starter',
    inputs: []
  },
  {
    id: 'python',
    name: 'Python FastAPI',
    logo: 'python',
    kind: 'app',
    group: 'Starters',
    hint: 'Modern Python 3.12+ ASGI service',
    inputs: []
  },
  {
    id: 'go',
    name: 'Go Web API',
    logo: 'go',
    kind: 'app',
    group: 'Starters',
    hint: 'High-throughput compiled web service',
    inputs: []
  },
  {
    id: 'rust',
    name: 'Rust Axum',
    logo: 'rust',
    kind: 'app',
    group: 'Starters',
    hint: 'Ultra-low latency memory-safe service',
    inputs: []
  },
  {
    id: 'strapi',
    name: 'Strapi CMS',
    logo: 'strapi',
    kind: 'app',
    group: 'Apps',
    hint: 'Open source Node.js Headless CMS',
    inputs: []
  },
  {
    id: 'n8n',
    name: 'n8n Automations',
    logo: 'n8n',
    kind: 'app',
    group: 'Apps',
    hint: 'Workflow automation platform',
    inputs: []
  },
  {
    id: 'metabase',
    name: 'Metabase',
    logo: 'metabase',
    kind: 'app',
    group: 'Apps',
    hint: 'Business analytics and dashboards',
    inputs: []
  }
];

export function seedCatalog(db) {
  const insertRegion = db.prepare(`
    INSERT INTO regions (id, name, country_code, available)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, country_code=excluded.country_code, available=excluded.available
  `);

  for (const r of DEFAULT_REGIONS) {
    insertRegion.run(r.id, r.name, r.countryCode, r.available ? 1 : 0);
  }

  const insertTemplate = db.prepare(`
    INSERT INTO templates (id, name, logo, kind, "group", hint, inputs)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, logo=excluded.logo, kind=excluded.kind, "group"=excluded."group", hint=excluded.hint, inputs=excluded.inputs
  `);

  for (const t of DEFAULT_TEMPLATES) {
    insertTemplate.run(
      t.id,
      t.name,
      t.logo,
      t.kind,
      t.group,
      t.hint,
      JSON.stringify(t.inputs || [])
    );
  }
}
