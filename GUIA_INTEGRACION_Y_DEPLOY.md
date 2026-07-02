# Guia de integracion y deploy - cotizador-ngc-pdf-service

## 1) Que espera este servicio para generar el PDF correctamente

Este servicio expone un endpoint HTTP para transformar HTML en PDF.

- Metodo: POST
- Ruta: /generate-pdf
- Content-Type: application/json
- Header requerido: x-pdf-secret
- Body requerido: objeto JSON con la propiedad html de tipo string

Ejemplo de request valida:

```json
{
  "html": "<html><body><h1>Cotizacion</h1><p>Detalle...</p></body></html>"
}
```

Headers minimos:

- Content-Type: application/json
- x-pdf-secret: valor igual a la variable PDF_SERVICE_SECRET del servicio

Respuesta esperada en caso exitoso:

- Status: 200
- Content-Type: application/pdf
- Content-Disposition: attachment; filename="cotizacion.pdf"
- Body: binario PDF

Errores comunes:

- 400 si falta html o no es string
- 401 si falta x-pdf-secret o no coincide
- 500 si Puppeteer falla al renderizar/generar PDF

### Recomendaciones para el HTML

- Enviar HTML completo (idealmente con html, head y body).
- Incluir estilos dentro de style en el mismo HTML para evitar dependencias externas.
- Evitar recursos que requieran autenticacion (imagenes privadas, fuentes privadas) salvo que sean publicos.
- Mantener el HTML por debajo de 2 MB (el servicio tiene limit JSON de 2mb).
- Esperar formato de pagina Letter y margenes fijos definidos por el servicio.

## 2) Contrato de integracion para usar en tu otro proyecto

Puedes copiar esta especificacion a Copilot Chat en tu otro repo:

"""
Integra este servicio externo de PDF:

- Endpoint: POST {PDF_SERVICE_URL}/generate-pdf
- Header obligatorio: x-pdf-secret con valor desde variable de entorno PDF_SERVICE_SECRET
- Header: Content-Type application/json
- Body JSON: { html: string }
- Si responde 200, el body es un PDF (application/pdf)
- Si responde 400/401/500, devolver error controlado con logs y mensaje legible

Requisitos de implementacion:
- Crear funcion generatePdfFromHtml(html)
- Validar que html sea string y no vacio antes de llamar al servicio
- Configurar timeout de 60s
- Reintentos: solo 1 retry en errores 5xx
- No loguear el secreto x-pdf-secret
- Guardar PDF en buffer/binario y retornar al caller
"""

## 3) Ejemplo de llamada desde Node.js (fetch)

```js
async function generatePdfFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('html must be a non-empty string');
  }

  const baseUrl = process.env.PDF_SERVICE_URL;
  const secret = process.env.PDF_SERVICE_SECRET;

  const res = await fetch(`${baseUrl}/generate-pdf`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-pdf-secret': secret,
    },
    body: JSON.stringify({ html }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PDF service error ${res.status}: ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

## 4) Variables de entorno sugeridas

En el proyecto cliente (el otro proyecto):

- PDF_SERVICE_URL=https://<tu-servicio>
- PDF_SERVICE_SECRET=<mismo secreto configurado en el servicio>

En este servicio (cotizador-ngc-pdf-service):

- NODE_ENV=production
- PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
- PDF_SERVICE_SECRET=<valor secreto>
- PORT — NO configurar manualmente en Railway; Railway lo inyecta automaticamente

Variables opcionales para ajustar limites desde el dashboard sin rebuild:

- RSS_RECYCLE_THRESHOLD_MB — MB de RSS al que se recicla Chromium (default: 700). Bajar a ~80% del limite de memoria del servicio.
- MAX_PAGES_PER_BROWSER — paginas renderizadas antes de reciclar Chromium (default: 50)
- MAX_QUEUE_DEPTH — requests en cola antes de responder 503 (default: 5)
- RENDER_TIMEOUT_MS — timeout en ms para setContent + page.pdf (default: 30000)
- IMAGE_SETTLE_TIMEOUT_MS — espera maxima para carga de imagenes en ms (default: 8000)

## 5) Deploy en Railway (hobby)

### Pasos iniciales

1. En railway.com, crear un nuevo proyecto y seleccionar "Deploy from GitHub repo".
2. Conectar el repositorio `cotizador-ngc-pdf-service`. Railway detecta `railway.toml` automaticamente y usa el Dockerfile.
3. En el panel de variables de entorno del servicio, agregar:
   - `PDF_SERVICE_SECRET` — el secreto compartido con el cliente
   - `PUPPETEER_EXECUTABLE_PATH` — `/usr/bin/chromium`
   - `NODE_ENV` — `production`
   - NO agregar `PORT` — Railway lo inyecta solo
4. En Settings > Resources, establecer el limite de memoria en **1 GB** como valvula de seguridad de costo. El servicio corre normalmente en ~150-250 MB en reposo.
5. Dejar una sola replica (ya configurado en `railway.toml`). El queue interno serializa las requests.

### Variables de entorno en el cliente (proyecto Next.js)

```
PDF_SERVICE_URL=https://<nombre-servicio>.up.railway.app
PDF_SERVICE_SECRET=<el mismo valor configurado en Railway>
```

### Costos esperados (hobby tier, trafico bajo)

- Reposo (browser caliente, sin requests): ~$2-3/mes
- Con renders ocasionales: se mantiene dentro del credito mensual de $5
- El browser se mantiene caliente (sin app-sleep) para latencia predecible

### Observabilidad

El endpoint `/health` (sin autenticacion) devuelve el estado del servicio:

```json
{
  "status": "ok",
  "browser": "up",
  "pagesRendered": 12,
  "rss": "198MB",
  "activeJobs": 0,
  "queuedJobs": 0
}
```

Usar este endpoint para monitorear RSS en produccion. Si `rss` sube constantemente entre renders, bajar `RSS_RECYCLE_THRESHOLD_MB` o `MAX_PAGES_PER_BROWSER`.

### Ajuste fino bajo presion de memoria

Si el servicio se reinicia por OOM:

1. Revisar los logs de Railway para confirmar que es un OOM kill (exit code 137).
2. Bajar `RSS_RECYCLE_THRESHOLD_MB` a ~80% del limite configurado (ej: limite 512 MB → valor 380).
3. Si los reinicios persisten, reducir `MAX_PAGES_PER_BROWSER` a 20 para reciclar Chromium con mas frecuencia.
4. El `restartPolicyType = ON_FAILURE` en `railway.toml` garantiza reinicio automatico tras un crash.

## 5) Smoke test rapido

```bash
curl -X POST "${PDF_SERVICE_URL}/generate-pdf" \
  -H "Content-Type: application/json" \
  -H "x-pdf-secret: ${PDF_SERVICE_SECRET}" \
  -d '{"html":"<html><body><h1>Test PDF</h1></body></html>"}' \
  --output test.pdf
```

Si test.pdf se genera y abre correctamente, la integracion esta OK.
