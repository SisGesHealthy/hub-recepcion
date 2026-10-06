# Flujo de correo de Hub Recepción (copia del flujo de la Power App)

El flujo actual arranca con **"Cuando Power Apps llame a un flujo (V2)"** y recibe los
datos como `text`, `text_1`… `text_18`. La app nueva no puede llamarlo, así que la copia
**se dispara sola cuando una recepción se finaliza** y lee los datos de las listas.

> Respeta los **nombres de las acciones** tal como aparecen aquí (Orden, Liberacion,
> Pallets, …). Las expresiones de las plantillas los usan; si cambia el nombre, la
> expresión falla.

## 0. Hacer la copia
En el flujo actual: **… → Guardar como** → nombre `Resumen de Recepción - Hub Recepción`.
El original se deja intacto para la Power App mientras se usen las dos en paralelo.
Abrir la **copia**.

## 1. Disparador
1. Eliminar "Cuando Power Apps llame a un flujo (V2)". Power Automate avisa que hay
   expresiones que lo usan: está bien, se reemplazan en el paso 4.
2. Agregar **SharePoint → Cuando se crea o modifica un elemento**:
   - Dirección del sitio: `EspacioColaborativo`
   - Nombre de la lista: **Recepciones**
3. Clic en el disparador → **Configuración → Condiciones del desencadenador → + Agregar**:
   ```
   @and(equals(triggerOutputs()?['body/Estado/Value'],'Finalizada'),equals(triggerOutputs()?['body/EstadoAnterior'],'En Proceso'))
   ```
   La app escribe `Estado = Finalizada` y `EstadoAnterior = En Proceso` en el mismo
   instante, al final, cuando la firma y los totales ya están guardados. Otro proceso
   cambia `EstadoAnterior` a "Finalizada" unos segundos después, así que el correo sale
   **una sola vez**.

## 1-b. Evitar correos duplicados (obligatorio)
Varias escrituras seguidas en la misma recepción pueden hacer que Power Automate arranque el
flujo **dos veces** con el mismo dato. Para que la segunda ejecución no envíe nada:

1. Disparador → **Configuración** → **Control de simultaneidad: Activado**, **Grado de
   paralelismo: 1**. Las ejecuciones van una detrás de otra, nunca al mismo tiempo.
2. Justo debajo del disparador, antes de "Orden":
   - **Obtener elemento** (SharePoint) → nombre **Actual** · Lista *Recepciones* · Id: `ID` del
     disparador.
   - **Condición**: `@{body('Actual')?['EstadoAnterior']}` **es igual a** `En Proceso`.
     - **Si no** → **Finalizar** (Terminate) con estado **Correcto**. Es un duplicado: no hace nada.
     - **Si sí** → primera acción: **Actualizar elemento** (SharePoint) · Lista *Recepciones* · Id:
       `ID` del disparador · **EstadoAnterior** = `Notificado`. Deja Estado = `Finalizada`
       (en "Actualizar elemento" hay que volver a poner los campos obligatorios). Después van
       todas las demás acciones (Orden, Liberacion, Pallets…, Redactar y los correos).
3. Si se había agregado el paso 6 (Actualizar EstadoAnterior = Finalizada al final), ya no hace
   falta: se puede eliminar.

Así, la primera ejecución marca la recepción como "Notificado" antes de enviar, y la segunda la
encuentra ya marcada y termina sin enviar.

## 2. Acciones nuevas (entre el disparador y las dos ramas)
Agregarlas **en este orden, una debajo de otra**, antes de que el flujo se divida:

| Nombre de la acción | Conector → acción | Configuración |
|---|---|---|
| **Orden** | SharePoint → Obtener elementos | Lista: *ÓRDENES DE RECEPCIÓN* · Consulta de filtro: `OData__x0049_D2 eq @{triggerBody()?['ID_1']}` · Número superior: `1` |
| **Liberacion** | SharePoint → Obtener elementos | Lista: *Liberaciones* · Filtro: `ID_1 eq @{triggerBody()?['ID_1']}` · Ordenar por: `ID desc` · Número superior: `1` |
| **Pallets** | SharePoint → Obtener elementos | Lista: *PalletsRecepcion* · Filtro: `RecepcionID_Num_x002c_ eq @{triggerBody()?['ID_1']} and HoraRegistro ge '@{addMinutes(triggerBody()?['HoraLlegada'], -1)}' and HoraRegistro le '@{triggerBody()?['HoraCierre']}'` · Ordenar por: `NumeroPallet asc` |
| **Adjuntos firma** | SharePoint → Obtener datos adjuntos | Lista: *Recepciones* · Id: `ID` del disparador |
| **Contenido firma** | SharePoint → Obtener contenido de datos adjuntos | Lista: *Recepciones* · Id: `ID` del disparador · Identificador de archivo: expresión `first(body('Adjuntos_firma'))?['Id']` |
| **Filas pallets** | Operación de datos → Seleccionar | Desde: `body('Pallets')?['value']` · Asignar (modo tabla): `Pallet` → `item()?['NumeroPallet']`, `Bruto kg` → `item()?['PesoBruto']`, `Envases` → `item()?['Envases']`, `Peso envase kg` → `item()?['P_unitario']`, `Neto kg` → `item()?['PesoNeto']` |
| **Tabla pallets** | Operación de datos → Crear tabla HTML | Desde: `body('Filas_pallets')` · Columnas: Automático |
| **Envases** | Operación de datos → Seleccionar | Desde: `body('Pallets')?['value']` · Asignar (cambiar a **modo texto**, ícono a la derecha): `item()?['Envases']` |
| **Total envases** | Operación de datos → Redactar | Entradas (expresión): `xpath(xml(json(concat('{"r":{"e":', string(body('Envases')), '}}'))), 'sum(/r/e)')` |

> **Por qué el filtro de Pallets lleva horas:** el número de orden (`ID_1`) no es único en
> el tiempo. Una orden recibida dos veces, o el mismo número al año siguiente (orden + día
> + mes), comparten pallets. Con el rango HoraLlegada–HoraCierre se toman solo los
> pallets de ESTA recepción.

## 3. Correo interno — reemplazar el contenido de **Redactar**
```html
<html>
  <body style="font-family: Arial; padding: 20px;">
    <h1 style="color:#0054A6;">Resumen de Recepción</h1>

    <h3>Datos Generales</h3>
    <p><b>Orden:</b> #@{triggerBody()?['ID_1']}</p>
    <p><b>Proveedor:</b> @{triggerBody()?['Proveedor']}</p>
    <p><b>Fruta:</b> @{triggerBody()?['Fruta']}</p>
    <p><b>Cantidad Programada:</b> @{first(body('Orden')?['value'])?['CantidadProgramada']} KG</p>
    <p><b>Fecha y hora programada:</b> @{convertTimeZone(first(body('Orden')?['value'])?['FechaProgramada'],'UTC','SA Pacific Standard Time','dd/MM/yyyy HH:mm')}</p>
    <p><b>Inicio / cierre de recepción:</b> @{convertTimeZone(triggerBody()?['HoraLlegada'],'UTC','SA Pacific Standard Time','dd/MM/yyyy HH:mm')} – @{convertTimeZone(triggerBody()?['HoraCierre'],'UTC','SA Pacific Standard Time','HH:mm')}</p>

    <h3>Liberación de Calidad</h3>
    <p><b>°Brix:</b> @{first(body('Liberacion')?['value'])?['OData__x00b0_Brix']}</p>
    <p><b>pH:</b> @{first(body('Liberacion')?['value'])?['PH']}</p>
    <p><b>Acidez:</b> @{first(body('Liberacion')?['value'])?['Acidez']}</p>
    <p><b>Analista:</b> @{first(body('Liberacion')?['value'])?['Operario']}</p>

    <h3>Pesaje</h3>
    <p><b>Peso Neto:</b> @{triggerBody()?['TotalNeto']} KG</p>
    <p><b>Peso Bruto:</b> @{triggerBody()?['TotalBruto']} KG</p>
    <p><b>Tara Total:</b> @{triggerBody()?['TotalTara']} KG</p>
    <p><b>N° Pallets:</b> @{length(body('Pallets')?['value'])}</p>
    <p><b>N° Envases:</b> @{outputs('Total_envases')}</p>
    <p><b>Faltante (−) / Excedente (+):</b> @{formatNumber(sub(float(triggerBody()?['TotalNeto']), float(first(body('Orden')?['value'])?['CantidadProgramada'])), '0.0')} KG</p>
    @{body('Tabla_pallets')}

    <h3>Transporte</h3>
    <p><b>Conductor:</b> @{triggerBody()?['Conductor']} · <b>Placa:</b> @{triggerBody()?['Placa']} · <b>Bodeguero:</b> @{triggerBody()?['Bodeguero']}</p>

    <h3>Firma del Proveedor</h3>
    <img src="data:image/png;base64,@{body('Contenido_firma')?['$content']}" width="400"/>

    <h3>Comentarios</h3>
    <p>@{triggerBody()?['ObservacionesProveedor']}</p>
  </body>
</html>
```
"Crear resumen" y "Enviar correo electrónico (V2)" siguen usando la salida de *Redactar*,
igual que antes.

## 4. Correo al proveedor — rama derecha
Se pueden **eliminar** "Obtener Hora Actual" y "Obtener Fecha Actual": la hora real de
cierre ya viene en la recepción. Reemplazar el contenido de **Redactar 1**:
```html
<h2>Constancia de Recepción de Fruta</h2>

<p>Estimado proveedor,</p>
<p>Se registró correctamente la recepción de su entrega con el siguiente detalle:</p>

<ul>
  <li><b>Proveedor:</b> @{triggerBody()?['Proveedor']}</li>
  <li><b>Fruta:</b> @{triggerBody()?['Fruta']}</li>
  <li><b>Fecha y hora programada:</b> @{convertTimeZone(first(body('Orden')?['value'])?['FechaProgramada'],'UTC','SA Pacific Standard Time','dd/MM/yyyy HH:mm')}</li>
  <li><b>Fecha y hora de cierre:</b> @{convertTimeZone(triggerBody()?['HoraCierre'],'UTC','SA Pacific Standard Time','dd/MM/yyyy HH:mm')}</li>
  <li><b>Cantidad programada:</b> @{first(body('Orden')?['value'])?['CantidadProgramada']} KG</li>
  <li><b>Cantidad recibida (neto):</b> @{triggerBody()?['TotalNeto']} KG</li>
  <li><b>N° de pallets / envases:</b> @{length(body('Pallets')?['value'])} / @{outputs('Total_envases')}</li>
  <li><b>Placa:</b> @{triggerBody()?['Placa']}</li>
  <li><b>Conductor:</b> @{triggerBody()?['Conductor']}</li>
</ul>

<p>Parámetros de recepción:</p>
<ul>
  <li><b>°Brix:</b> @{first(body('Liberacion')?['value'])?['OData__x00b0_Brix']}</li>
  <li><b>pH:</b> @{first(body('Liberacion')?['value'])?['PH']}</li>
  <li><b>Acidez:</b> @{first(body('Liberacion')?['value'])?['Acidez']}</li>
</ul>

<p>Observaciones: @{triggerBody()?['ObservacionesProveedor']}</p>

<h3>Firma del Proveedor</h3>
<img src="data:image/png;base64,@{body('Contenido_firma')?['$content']}" width="400"/>
```
En **Enviar correo electrónico (V2) 1 1** → *Para*: `@{triggerBody()?['Correo']}`.

**Recomendado:** Gmail y Hotmail suelen bloquear las imágenes incrustadas como
`data:image/png`, así que el proveedor puede no ver la firma. En los dos "Enviar correo",
abrir **Parámetros avanzados → Datos adjuntos**: *Nombre* `Firma_recepcion.png` ·
*Contenido* `body('Contenido_firma')`. Así la firma llega siempre como archivo adjunto.

## 5. Probar
1. Guardar → **Probar → Manualmente**.
2. En la app, cerrar una recepción de prueba.
3. En el historial de ejecuciones debe aparecer **una sola** ejecución, con los dos correos.

Si una acción "Obtener elementos" falla con *"columna no existe"*, revisar que la consulta
de filtro esté escrita tal cual (`OData__x0049_D2` lleva dos guiones bajos después de
OData).
