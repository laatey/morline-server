import app from './src/index.js';
import fs from 'node:fs';
import yaml from 'yaml';

const specText = fs.readFileSync('./openapi/openapi.yaml', 'utf8');
const spec = yaml.parse(specText);

// Extract Express routes
function getExpressRoutes(app) {
  const routes = [];

  function print(path, layer) {
    if (layer.route) {
      const p = (path + layer.route.path).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      for (const method in layer.route.methods) {
        if (layer.route.methods[method]) {
          routes.push({ method: method.toUpperCase(), path: p });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      let routerPath = path;
      if (layer.regexp) {
        // extract prefix from regexp
        let src = layer.regexp.source || '';
        src = src.replace(/\\\//g, '/');
        src = src.replace(/\^/g, '');
        src = src.replace(/\\\?/g, '?');
        src = src.replace(/\(\?=\\\/\|\$\)/g, '');
        src = src.replace(/\(\?=\/\|\$\)/g, '');
        src = src.replace(/\/\?$/g, '');
        if (src && src !== '/') {
          routerPath = (path + '/' + src).replace(/\/+/g, '/');
        }
      }
      layer.handle.stack.forEach(child => print(routerPath, child));
    }
  }

  app._router.stack.forEach(layer => print('', layer));
  return routes;
}

const expressRoutes = getExpressRoutes(app);
console.log('Total registered Express routes found:', expressRoutes.length);

// Compare against OpenAPI spec paths
const specPaths = spec.paths || {};
let totalOps = 0;
let missingOps = [];
let matchedOps = 0;

for (const [openApiPath, methods] of Object.entries(specPaths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    totalOps++;

    const expressEquivalent = '/v1' + openApiPath.replace(/\{([^}]+)\}/g, ':$1');

    const found = expressRoutes.find(r => 
      r.method === method.toUpperCase() && 
      (r.path === expressEquivalent || r.path === expressEquivalent.replace(/\/$/, ''))
    );

    if (found) {
      matchedOps++;
    } else {
      missingOps.push({ method: method.toUpperCase(), path: openApiPath, expected: expressEquivalent });
    }
  }
}

console.log(`Matched: ${matchedOps} / ${totalOps}`);
if (missingOps.length > 0) {
  console.log(`Missing/Mismatched endpoints (${missingOps.length}):`);
  missingOps.forEach(m => console.log(`  ${m.method.padEnd(6)} ${m.path} -> expected: ${m.expected}`));
} else {
  console.log('🎉 100% of OpenAPI endpoints are verified and implemented in the Express routes!');
}

process.exit(0);
