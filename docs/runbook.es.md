# Runbook (español)
Traducción de las secciones de operación de `docs/runbook.md`: desplegar, crear el owner, rotar secretos y cambiar el modo
de integraciones. Si las dos versiones difieren, manda la versión en inglés; corregir la traducción en el mismo PR.

## Desplegar
Staging: merge a `main` → CI ejecuta `infra/deploy.sh staging` (rol OIDC de GitHub, un despliegue de staging a la vez) y
luego `infra/smoke.sh`. Producción: `git tag vX.Y.Z && git push --tags` → aprobar en el entorno `production` de GitHub →
Jaime aprueba en el chat (N07). Nunca desplegar a mano mientras CI despliega, ni editar variables en la consola durante un
despliegue.

Qué garantiza `infra/deploy.sh`:
1. **Candado.** Aborta (código 3, sin cambios) si Lightsail muestra un despliegue en curso (`DEPLOYING`, `UPDATING`,
   `PENDING` o un despliegue `ACTIVATING`), y otra vez si el despliegue ACTIVO cambió mientras corría (alguien desplegó o
   guardó una edición en la consola). Se vuelve a ejecutar cuando el otro cambio termina y entonces parte de ese cambio.
2. **Se conservan las ediciones de la consola.** El entorno nuevo parte del despliegue ACTIVO ACTUAL
   (`infra/deploy_env.py`). La plantilla solo fija `NODE_ENV`, `PORT`, `REQUIRE_PRIVILEGED_2FA`; los valores de Secrets
   Manager (si ese secreto existe) ganan en el contenedor `app`. Se eliminan las claves que gestiona el despliegue:
   `APP_VERSION` (ahora va dentro de la imagen) y cualquier `BOOTSTRAP_*`. El `worker` siempre recibe los valores de `app`,
   así que nunca discrepan (por ejemplo en `INTEGRATIONS_MODE`).
3. **Diferencias por nombre.** Antes de desplegar imprime, por contenedor, los NOMBRES de variables añadidas (`+`),
   eliminadas (`-`) y cambiadas (`~`). Nunca los valores.
4. **Versión.** La imagen se construye con `--build-arg GIT_SHA=$(git rev-parse --short=7 HEAD)` y `/api/health` informa
   ese SHA desde `/app/VERSION`. El script rechaza un árbol de trabajo con cambios sin commit, espera a que la versión NUEVA
   del despliegue quede `ACTIVE` (máximo 15 min) y, si termina `FAILED`/`INACTIVE` o se agota el tiempo, imprime el final del
   log de cada contenedor (la versión anterior sigue sirviendo).
5. **Humo.** `infra/smoke.sh <url>` falla si `/api/health` no responde `ok:true` CON `version` igual al SHA desplegado.

## Crear el owner (entorno nuevo)
Se eliminó el arranque por variables de entorno (`BOOTSTRAP_OWNER_*`): dejaba la contraseña en el historial de despliegues
de Lightsail para siempre. La API ahora no arranca en producción si existe alguna variable `BOOTSTRAP_*`.
En su lugar, el comando de un solo uso. Solo necesita `DATABASE_URL`; lee la contraseña de un prompt oculto (se escribe dos
veces) o de stdin, nunca de argumentos ni de variables de entorno; crea el tenant demo y su lista de precios si faltan, y
**nunca modifica un usuario existente** (código 3, nada escrito). Códigos: 0 creado, 2 uso o contraseña débil, 3 ya existe.

- Desde una máquina de confianza con el repo (`DATABASE_URL` en `.env` o en la shell, apuntando a la base de destino):
  `pnpm create-owner --email owner@example.com`
- Contenedor de un solo uso con el commit desplegado (las imágenes del registro de Lightsail no se pueden descargar; se
  construye el mismo commit: `git checkout <sha> && docker build -f infra/Dockerfile --build-arg GIT_SHA=<sha> -t app:<sha> .`):
  `docker run --rm -it -e DATABASE_URL app:<sha> node apps/api/dist/cli/create-owner.js --email owner@example.com`
  (`-it` pide la contraseña oculta; con `-i` y una tubería lee la primera línea de stdin). Exportar `DATABASE_URL` antes:
  `-e DATABASE_URL` sin valor lo pasa sin escribirlo en la línea de comandos.
- La base gestionada de Lightsail es privada. Para una ejecución puntual, Jaime activa el modo público de la base solo los
  minutos necesarios, desde una red de confianza, ejecuta el comando por TLS y lo desactiva; se anota en `docs/LOGBOOK.md`.

Después: abrir la URL, entrar, activar 2FA (`REQUIRE_PRIVILEGED_2FA=true`) y guardar los códigos de recuperación en el
gestor de contraseñas. Staging ya tiene su owner (creado con el arranque antiguo en el despliegue v9; su contraseña se ve en
el historial de despliegues, así que el owner la cambia desde la aplicación; tiene 2FA activo).

## Rotar secretos
Modelo de amenazas: `docs/secrets.md`. Todo valor se genera, nunca se teclea: `openssl rand -base64 48` (SESSION_SECRET),
`openssl rand -base64 32` (TOTP_ENC_KEY). La API rechaza valores débiles en producción (longitud, valores de ejemplo,
patrones repetidos, entropía). Se cambian en la consola de Lightsail (contenedor `app`; el siguiente despliegue alinea el
`worker`) o en el secreto de Secrets Manager, y luego se despliega. Nunca se pegan en el chat ni en tickets.

| Secreto | Efecto de rotarlo | Procedimiento |
|---|---|---|
| `SESSION_SECRET` | Todas las sesiones y la cookie del paso 2FA dejan de valer: todos vuelven a entrar. Cambian los seudónimos de email en los logs (no se correlacionan antes y después). Seguro. | Valor nuevo → desplegar → comprobar el inicio de sesión. |
| `DATABASE_URL` (contraseña) | Errores breves si la app usa la contraseña antigua cuando la base ya cambió. | Base de Lightsail → cambiar la contraseña maestra → actualizar `DATABASE_URL` enseguida → desplegar → `/api/health` `deps.db: ok`. En horario tranquilo. |
| `TOTP_ENC_KEY` | **No se rota como los demás.** Cifra la semilla TOTP de cada usuario y es la llave de los hashes de los códigos de recuperación. Una llave nueva deja ilegible todo 2FA activo: owners y admins quedan fuera. | Una rotación planificada necesita código que aún no existe (id de llave en el cifrado, descifrar con la antigua y la nueva, tarea de re-cifrado y retirar la antigua; los usuarios regeneran sus códigos de recuperación porque esos hashes no se pueden re-cifrar). Hasta entonces, solo si la llave se compromete: con aprobación de Jaime, llave nueva, reiniciar el 2FA de todos (sentencia de la sección "Two-factor authentication" sin el `WHERE` por id), desplegar, avisar, y cada usuario con 2FA lo vuelve a activar. |
| Llaves de proveedores (`STRIPE_*`, `RESEND_API_KEY`) | Ninguno si se hace en orden. | Crear la llave nueva en el proveedor, actualizar la variable, desplegar, comprobar, revocar la antigua. |
| Contraseña del owner | Solo ese usuario. | El owner la cambia desde la aplicación (el 2FA protege la cuenta mientras tanto). |

## Cambiar el modo de integraciones
`INTEGRATIONS_MODE` es `fake | test | live` (sin distinguir mayúsculas; el nombre antiguo `sandbox` se acepta como `test`).
App y worker reciben siempre el mismo valor de `infra/deploy.sh`; ambos lo registran al arrancar y `/api/health` lo muestra
en `mode`.

| Modo | Qué funciona | Variables obligatorias (API y worker no arrancan sin ellas) |
|---|---|---|
| `fake` | Adaptadores internos; nada sale del servicio. | Ninguna. Staging sigue aquí hasta que Jaime decida otra cosa. |
| `test` | Stripe en modo prueba, bandeja de prueba de Resend. | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (`sk_test_`/`rk_test_`), `STRIPE_WEBHOOK_SECRET` (`whsec_`), `MESSAGING_PROVIDER=resend`, `RESEND_API_KEY`, `MESSAGING_FROM`. |
| `live` | Dinero y mensajes reales. | Igual que `test` con llave de Stripe LIVE (`sk_live_`/`rk_live_`). Solo con llaves de producción cargadas por Jaime y su aprobación (CLAUDE.md, N07). |

Procedimiento: añadir las variables obligatorias al contenedor `app` (consola o Secrets Manager), fijar
`INTEGRATIONS_MODE`, desplegar, revisar los nombres `+`/`~` en el log del despliegue y comprobar `/api/health` → `mode`.
Para volver: `fake` y desplegar. Las cotizaciones de transportista aún no tienen adaptador real: siguen en fake en todo modo.
