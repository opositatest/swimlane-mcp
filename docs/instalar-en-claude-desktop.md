# Instalar Swimlane en Claude Desktop

Con Swimlane puedes preguntarle a Claude por tus tareas de KanbanFlow, o por las de un compañero, sin salir del chat. Solo lee los tableros: nunca cambia nada.

Con un cliente que integre el runtime Node no necesitas instalar nada más ni saber programar. Tardas unos 5 minutos.

## Antes de empezar

- **Un cliente compatible con extensiones `.mcpb`**, instalado y actualizado. La extensión admite **macOS, Windows y Linux (incluido Ubuntu)**. En Linux, comprueba que tu cliente admite MCPB y proporciona Node.js 24+; si no lo incluye, tendrás que instalarlo.
- **Acceso al tablero** de KanbanFlow que quieres consultar.

## 1. Consigue el token de tu tablero

El token es una clave que permite a Swimlane leer un tablero. Cada tablero tiene el suyo.

1. Abre el tablero en [kanbanflow.com](https://kanbanflow.com).
2. Abre el **menú del tablero** (arriba a la derecha) y entra en **Settings**.
3. Ve a **API & Webhooks** y crea un token (**Add API token**).
4. Copia el token. Lo vas a pegar en el paso 3.

> Si no ves la opción **API & Webhooks**, puede que tu usuario no tenga permiso para crear tokens. Pídeselo a quien administre el tablero.

¿Usas varios tableros? Repite estos pasos en cada uno y guarda todos los tokens.

## 2. Instala la extensión

1. Descarga el fichero **`swimlane-mcp-….mcpb`** de la [última versión](https://github.com/opositatest/swimlane-mcp/releases/latest), en el apartado *Assets*.
2. Haz **doble clic** en el fichero. Se abrirá Claude Desktop con la ventana de instalación.
3. Pulsa **Install**.

Si el doble clic no abre Claude: en Claude Desktop ve a **Settings → Extensions → Advanced settings → Install Extension…** y elige el fichero. En otros clientes, utiliza su opción para importar extensiones MCPB.

### Ubuntu / Linux

Las versiones **0.0.3+** declaran Linux en el manifiesto; los `.mcpb` anteriores solo declaraban macOS y Windows y podían mostrar un aviso de sistema operativo incompatible. Descarga e instala la extensión actualizada para eliminar esa restricción.

Esta compatibilidad corresponde al servidor Swimlane, no instala ni añade soporte Linux al propio cliente. Si tu cliente de Ubuntu no puede importar `.mcpb`, utiliza la [instalación npm](../README.md#other-clients-npx) con Node.js 24+ y configura el servidor como MCP local por stdio.

## 3. Configúrala

Claude te pedirá dos datos:

| Campo | Qué poner |
|-------|-----------|
| **KanbanFlow API tokens** | El token del paso 1. Si tienes varios, pégalos separados por comas. |
| **Your KanbanFlow email** | El email con el que entras en KanbanFlow. Así Claude sabe cuáles son *tus* tareas. |

Guarda y comprueba que la extensión está **activada**. Claude Desktop guarda el token cifrado en tu ordenador; en otros clientes, revisa cómo protegen la configuración.

## 4. Pruébala

Abre un chat nuevo y pregunta:

- «¿Qué tareas tengo en KanbanFlow?»
- «¿Qué tengo en curso y en revisión?»
- «¿En qué está trabajando Laura?»
- «¿Qué terminé este mes?»

La primera vez Claude puede pedirte permiso para usar la herramienta. Pulsa **Allow**.

## Si algo no funciona

| Qué ves | Qué hacer |
|---------|-----------|
| Claude dice que el token es incorrecto o que fue revocado (HTTP 401) | Crea un token nuevo (paso 1) y cámbialo en **Settings → Extensions → Swimlane for KanbanFlow → Configure**. |
| Claude dice que no sabe quién eres | Añade tu email de KanbanFlow en la configuración de la extensión (paso 3). |
| No encuentra a una persona | Prueba con su nombre completo o su email. Tiene que ser miembro de alguno de tus tableros. |
| Claude no usa la herramienta | Comprueba en **Settings → Extensions** que está activada y abre un chat nuevo. |
| Dice que faltan tareas antiguas de «Done» | KanbanFlow entrega las columnas grandes por partes. Pídele «carga la columna Done completa». |

## Privacidad

- Swimlane **solo lee**. No puede crear, mover ni borrar tareas.
- Lo que consultes (nombres de tareas, descripciones, nombres de compañeros) se envía a Claude para que pueda responderte. Usa solo tableros cuyo contenido puedas compartir con Claude.
- Tu token no sale de tu ordenador salvo hacia KanbanFlow.

Más detalles en [SECURITY.md](../SECURITY.md).

## Actualizar

Cuando haya una versión nueva, descarga el nuevo `.mcpb` de la [página de versiones](https://github.com/opositatest/swimlane-mcp/releases/latest) y vuelve a instalarlo. Tu configuración se mantiene.

---

Proyecto no oficial, sin relación con KanbanFlow.
