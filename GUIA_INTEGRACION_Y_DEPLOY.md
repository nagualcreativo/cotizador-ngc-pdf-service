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

- PDF_SERVICE_URL=https://<tu-servicio-cloud-run>
- PDF_SERVICE_SECRET=<mismo secreto configurado en Cloud Run>

En este servicio (cotizador-ngc-pdf-service):

- PORT=3001
- NODE_ENV=production
- PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
- PDF_SERVICE_SECRET=<valor secreto>

## 5) Smoke test rapido

```bash
curl -X POST "${PDF_SERVICE_URL}/generate-pdf" \
  -H "Content-Type: application/json" \
  -H "x-pdf-secret: ${PDF_SERVICE_SECRET}" \
  -d '{"html":"<html><body><h1>Test PDF</h1></body></html>"}' \
  --output test.pdf
```

Si test.pdf se genera y abre correctamente, la integracion esta OK.
