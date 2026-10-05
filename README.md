# Hub Recepción — Recepción de fruta y liberaciones de Calidad

Reemplazo de la Power App "Tipo de recepción" (Bodega / Calidad / Calidad - Planta).
PWA en JavaScript sin frameworks, mismo patrón que Hub Asistencia/Hub Limpieza.
**Usa las mismas listas de SharePoint** de `EspacioColaborativo`; no hay que crear
listas ni columnas.

| Pantalla | Lee | Escribe |
|---|---|---|
| Bodega | ÓRDENES DE RECEPCIÓN (`Lists/RECEPCIONES`) | Recepciones (`Lists/Recepciones1`), PalletsRecepcion, Estado de la orden |
| Calidad | ÓRDENES DE RECEPCIÓN, Liberaciones (referencia) | Liberaciones, Estado_calidad de la orden |
| Calidad - Planta | Lotes, Registros, Catalogo-Parametros-Liberacion | Registros, Estado del lote |

Enlace entre listas (igual que en la Power App): el `ID_N` de la orden (ej. `20510`) se
copia en `Liberaciones.ID_1`, `PalletsRecepcion.RecepcionID` y `Recepciones.ID_1`.

## Qué mejora frente a la Power App

**Bodega**
- Entra directo a sus órdenes, sin la pantalla de departamento (la cuenta solo tiene uno).
- Órdenes agrupadas en Hoy, Próximas y Atrasadas. Las atrasadas (como las de agosto que
  seguían en la lista) quedan plegadas aparte.
- En lugar de un botón gris, cada orden dice por qué no se puede recibir: *Esperando
  liberación de Calidad* o *Rechazada por Calidad*. La lista se refresca sola cada 45 s,
  así que cuando Calidad libera, el botón se activa sin tocar nada.
- Si una recepción quedó a medias, la orden muestra *Continuar · N pallets* y no se crea una
  segunda (la Power App dejó 6 recepciones colgadas "En Proceso").
- Pallet en la misma pantalla: la cámara abre directo, la foto se reduce a ~150 KB, el neto
  se calcula mientras se escribe, y el peso por envase y la tara se recuerdan por proveedor
  y fruta. Se pueden guardar varios pallets seguidos sin cambiar de pantalla.
- Barra de avance de neto recibido contra lo programado, con aviso si se pasa de ±10 %.
- **Funciona sin señal**: cada pallet se guarda en la tablet y se sube solo al volver el
  wifi (indicador "↻ Subiendo N" / "✓ Al día").
- Cierre de la recepción:
  - Correo, conductor y placa se precargan con los del último envío del mismo proveedor.
  - Detecta correos mal escritos ("gmaio.com", "hotmial.com", ".con"…) y sugiere la
    corrección. Hoy hay decenas de errores así en el historial, y 204 recepciones se
    mandaron a `sistemasdegestionhf@gmail.com` como relleno.
  - El bodeguero queda recordado en el dispositivo y el comentario se propone solo
    ("Se reciben 32 envases de maracuyá").
- **Corrige dos errores de datos de la Power App**:
  - `TotalTara` quedaba siempre en 0.
  - `TotalNeto` truncaba los decimales (1424,5 se guardaba como 1424).

**Calidad (materia prima)**
- Un solo paso: abrir la orden, ingresar °Brix, pH y acidez, y liberar o rechazar.
- Muestra los últimos análisis de la misma fruta como referencia, y el ratio en vivo.
- Avisa ante valores imposibles (pH 31 en vez de 3,1). El rechazo exige un motivo.

**Calidad - Planta (producto en proceso)**
- Solo muestra los lotes de los últimos 5 días. Hoy los 269 lotes siguen en "Programado"
  porque nunca se cierran; ahora hay un botón **Cerrar lote**.
- Los rangos del producto (que ya existen en Catalogo-Parametros-Liberacion) se muestran
  y cada campo se pone verde o rojo mientras se escribe. El ratio se calcula solo.
- El número de parada se asigna solo y la marca *Repetición* conserva el número anterior.

## Puesta en marcha (una sola vez)

### 1. Registro propio en Entra ID (lo hace un administrador)
Requiere una cuenta con rol *Administrador de aplicaciones* o *Administrador global*
(`sistemasdegestion@` no puede hacerlo).
1. **Entra ID → Registros de aplicaciones → Nuevo registro**: nombre **Hub Recepción**,
   "Cuentas de este directorio organizativo solamente". Sin URI por ahora → Registrar.
2. **Authentication → Agregar una plataforma → Aplicación de página única**:
   - `http://localhost:8794/` (pruebas)
   - `https://sisgeshealthy.github.io/hub-recepcion/` (producción)
3. **Permisos de API → Agregar un permiso → SharePoint → Permisos delegados → `AllSites.Write`**
   → **Conceder consentimiento de administrador**. (Se puede quitar `User.Read` de Graph si
   viene por defecto; no se usa.)

   Este permiso es necesario porque las fotos de pallet y la firma se guardan como
   *adjuntos* del ítem (así las guarda la Power App en sus columnas de imagen), y
   Microsoft Graph no sabe escribir adjuntos de lista.
4. Copiar el **Id. de aplicación (cliente)** (no es secreto) en `js/config.js → msal.clientId`
   y cambiar `useMock: true` → `false`.

Se usa un registro propio (y no el de Hub Asistencia) para que cada app tenga solo sus
permisos y no dependan una de la otra.

### 2. Flujo de correo (opción A: cambiar solo el disparador)
El flujo actual empieza con *"Cuando Power Apps llama a un flujo (V2)"*, que una PWA no puede
invocar. Para no cortar la Power App durante la semana en paralelo:

1. Abrir el flujo con la cuenta propietaria → **Guardar como** (copia). El original sigue
   atendiendo a la Power App.
2. En la copia, eliminar el disparador de Power Apps y poner **SharePoint → Cuando se crea o
   modifica un elemento**: sitio `EspacioColaborativo`, lista **Recepciones**.
3. En el disparador → **Configuración → Condiciones de desencadenador**, pegar:
   ```
   @and(equals(triggerOutputs()?['body/Estado/Value'],'Finalizada'),equals(triggerOutputs()?['body/EstadoAnterior'],'En Proceso'))
   ```
   (La app marca `EstadoAnterior = "En Proceso"` en el mismo instante en que finaliza, y ese
   cambio se hace al final, cuando la firma y los totales ya están guardados.)
4. En "Redactar", "Crear resumen" y los dos "Enviar correo", reemplazar cada dato que venía
   de Power Apps por el contenido dinámico del disparador: `Proveedor`, `Fruta`, `TotalNeto`,
   `TotalBruto`, `TotalTara`, `Correo`, `Conductor`, `Placa`, `Bodeguero`,
   `ObservacionesProveedor`, `HoraLlegada`, `HoraCierre`, `ID_1`.
5. Si el resumen lleva el detalle de pallets: **Obtener elementos** de *PalletsRecepcion* con
   la consulta de filtro `RecepcionID_Num_x002c_ eq @{triggerOutputs()?['body/ID_1']}`.
6. Como último paso, **Actualizar elemento** en *Recepciones* (Id = `ID` del disparador) con
   `EstadoAnterior = Finalizada`. Así, si alguien edita después esa recepción, el correo no
   se reenvía.

Cuando la Power App se retire, se apaga el flujo original.

### 3. Publicar
Igual que Hub Asistencia: repositorio `SisGesHealthy/hub-recepcion` y GitHub Pages sobre
`master`. Luego se instala en la tablet de bodega y en la de calidad ("Agregar a la
pantalla de inicio").

### 4. Primera prueba real (recomendado)
Que Compras cree una orden de prueba (proveedor "PRUEBA"). Calidad la libera, Bodega
registra 1-2 pallets con foto y cierra. Verificar en SharePoint:
- La foto se ve en la columna FotoPallet y la firma en FirmaProveedor.
- Los totales coinciden.
- Llega el correo.

Después, borrar los ítems de prueba.

## Accesos
`js/config.js → accesos`: correo de la cuenta Microsoft → departamentos. Hoy:
`bodega2@` → Bodega · `calidad@`, `calidad2@` → Calidad y Calidad - Planta ·
`sistemasdegestion@` → todo. Las iniciales de bodegueros y de responsables de planta también
están en ese archivo.

## Desarrollo
```
python serve_dev.py 8794
```
En modo demo (`useMock: true`) los datos viven en el IndexedDB del navegador y el selector
de la barra superior cambia de cuenta (bodega / calidad / sistemas).
