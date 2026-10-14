export const prefix = '/';

export default async function root(app) {
  app.get('/', { config: { public: true } }, async () => ({ name: {{name|json}}, status: 'ok' }));
}
