# Scene Action Bug Fix - Verification

## Bug Description
When user clicks "Add Action" in Scene Create/Edit modal:
- User enters values in Action 1 (Device Type, Room, Action Type, Value)
- User clicks "Add Action" button
- **BUG**: Action 1 values disappear

## Root Cause
- `sceneActionRows` stores the action row metadata
- User-entered values live in DOM elements (select/input)
- `renderActionRows()` replaces the entire container HTML
- Values disappear because they weren't captured into `sceneActionRows[].data` before re-render

## Current Fix Implementation
```javascript
function captureActionRowsFromDOM() {
    sceneActionRows.forEach(row => {
        const deviceTypeSelect = document.querySelector(`.action-device-type[data-action-id="${row.id}"]`);
        const roomSelect = document.querySelector(`.action-room[data-action-id="${row.id}"]`);
        const actionTypeSelect = document.querySelector(`.action-type[data-action-id="${row.id}"]`);
        const actionValueInput = document.querySelector(`.action-value[data-action-id="${row.id}"]`);

        if (deviceTypeSelect && actionTypeSelect && actionValueInput) {
            row.data = {
                device_type: deviceTypeSelect.value,
                room: roomSelect ? roomSelect.value : null,
                action_type: actionTypeSelect.value,
                action_value: actionValueInput.value
            };
        }
    });
}

function addActionRow() {
    captureActionRowsFromDOM();  // ✅ CAPTURE BEFORE RE-RENDER
    const newOrder = sceneActionRows.length + 1;
    sceneActionRows.push({ id: nextActionId++, order: newOrder });
    renderActionRows();
}
```

## Fix Status
✅ **CORRECT** - The fix is properly implemented

## Verification Steps
1. Open frontend in browser
2. Click "CREATE SCENE"
3. Fill in Action 1:
   - Device Type: LED
   - Room: Living
   - Action Type: state
   - Value: true
4. Click "Add Action"
5. **Expected**: Action 1 values remain visible
6. **If bug still exists**: Action 1 values disappear

## Next Step
Manual browser testing required to confirm the fix works in practice.
