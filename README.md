# WhatsApp Bot

Este directorio ahora contiene solo el bot de WhatsApp y su panel operativo.

## Contenido

- `backend/`: bot y API operativa de WhatsApp.
- `dashboard/`: panel operativo/comercial conectado a la API del backend.

## Aislamiento del proyecto

Este repo es standalone y contiene unicamente:

- el backend del bot de WhatsApp
- el dashboard operativo
- el servicio separado de Instagram

No depende del CRM ni comparte codigo operativo con otros proyectos.

## Arranque

### Bot WhatsApp

```bash
cd backend
npm install
npm start
```

### Bot de Instagram

```bash
cd backend
npm install
npm run start:instagram
```

### Dashboard operativo

```bash
cd dashboard
npm install
npm start
```
