// ─── Constants ───
const DEFAULT_HEIGHT = 160;
const DEFAULT_WIDTH = 220;
const MIN_NOTE_WIDTH = 120;
const MAX_NOTE_WIDTH = 600;
const MIN_NOTE_HEIGHT = 80;
const MAX_NOTE_HEIGHT = 500;
const SNAP_X_THRESHOLD = 120;
const SNAP_Y_ABOVE = 50;
const DOUBLE_CLICK_MS = 400;

// ─── DOM References ───
const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const canvas = $('canvas');
const emptyMsg = $('empty-msg');
const exportPanel = $('export-panel');
const exportText = $('export-text');
const importPanel = $('import-panel');
const importText = $('import-text');

// ─── App State ───
let notes = [];
let activeNote = null;
let resizingNote = null;
let offset = { x: 0, y: 0 };
let resizeStart = { y: 0, height: 0 };
let highestZ = 100;
let hoverRoot = null;
let hoverInsertIndex = 0;
let insertionPreview = null;

// ─── Reusable Helpers ───
const getNoteEl = (id) => $('note-' + id);
const noteHeight = (n) => n.height || DEFAULT_HEIGHT;
const noteWidth = (n) => n.width || DEFAULT_WIDTH;
const CONTENT_SEP = '\n---\n';

/** Split note content into word (top) and definition (bottom) */
function splitContent(content) {
    const idx = (content || '').indexOf(CONTENT_SEP);
    if (idx === -1) return { word: content || '', def: '' };
    return { word: content.substring(0, idx), def: content.substring(idx + CONTENT_SEP.length) };
}

/** Join word and definition back into a single content string */
function joinContent(word, def) {
    if (!def) return word;
    return word + CONTENT_SEP + def;
}

/** Get sorted children of a pin root, optionally excluding a note by ID */
function getChildren(parentId, excludeId) {
    return notes
        .filter(n => n.parentPinId === parentId && n.id !== excludeId)
        .sort((a, b) => a.stackOrder - b.stackOrder);
}

/** Sort notes by visual position (top-to-bottom, left-to-right) */
function sortByPosition(items) {
    return items.slice().sort((a, b) =>
        Math.abs(a.y - b.y) < 30 ? a.x - b.x : a.y - b.y
    );
}

// ═══════════════════════════════════════
// SECTION: Infinite Canvas (Pan & Transform)
// ═══════════════════════════════════════

let panX = 0, panY = 0;
let isPanning = false;
let touchPanActive = false;
let panStart = { x: 0, y: 0 };
let panStartOffset = { x: 0, y: 0 };

function applyCanvasTransform(animate) {
    if (animate) {
        canvas.classList.add('canvas-animating');
        setTimeout(() => canvas.classList.remove('canvas-animating'), 450);
    }
    canvas.style.transform = `translate(${panX}px,${panY}px)`;
}

function screenToCanvas(sx, sy) {
    return { x: sx - panX, y: sy - panY };
}

function startPan(x, y) {
    isPanning = true;
    panStart.x = x;
    panStart.y = y;
    panStartOffset.x = panX;
    panStartOffset.y = panY;
}

function updatePan(x, y) {
    panX = panStartOffset.x + (x - panStart.x);
    panY = panStartOffset.y + (y - panStart.y);
    applyCanvasTransform(false);
}

function endPan() {
    isPanning = false;
    touchPanActive = false;
    viewport.style.cursor = '';
    savePan();
}

// ─── Mouse panning ───
viewport.addEventListener('mousedown', (e) => {
    if (e.target !== viewport && e.target !== canvas) return;
    startPan(e.clientX, e.clientY);
    viewport.style.cursor = 'grabbing';
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (isPanning) { updatePan(e.clientX, e.clientY); return; }
    handleDragMove(e.clientX, e.clientY);
});

document.addEventListener('mouseup', () => {
    if (isPanning) { endPan(); return; }
    endMove();
});

// ─── Touch panning ───
viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        touchPanActive = true;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        startPan(mx, my);
        e.preventDefault();
        return;
    }
    if (e.target === viewport || e.target === canvas) {
        startPan(e.touches[0].clientX, e.touches[0].clientY);
        e.preventDefault();
    }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
    if (touchPanActive && e.touches.length === 2) {
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        updatePan(mx, my);
        e.preventDefault();
        return;
    }
    if (isPanning && e.touches.length === 1) {
        updatePan(e.touches[0].clientX, e.touches[0].clientY);
        e.preventDefault();
        return;
    }
    if (e.touches.length === 1) {
        handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
}, { passive: false });

document.addEventListener('touchend', () => {
    if (touchPanActive || isPanning) { endPan(); return; }
    endMove();
});

// ═══════════════════════════════════════
// SECTION: Persistence (Load / Save)
// ═══════════════════════════════════════

function savePan() {
    localStorage.setItem('bibo-pan', JSON.stringify({ x: panX, y: panY }));
}

function saveNotes() {
    localStorage.setItem('drag-notes-v5', JSON.stringify(notes));
}

function updateEmptyState() {
    emptyMsg.style.display = notes.length === 0 ? 'block' : 'none';
}

window.onload = () => {
    const saved = localStorage.getItem('drag-notes-v5');
    if (saved) {
        notes = JSON.parse(saved);
        notes.forEach(n => createNoteElement(n));
        refreshStacks();
        updateEmptyState();
    }
    const savedPan = localStorage.getItem('bibo-pan');
    if (savedPan) {
        const p = JSON.parse(savedPan);
        panX = p.x || 0;
        panY = p.y || 0;
        applyCanvasTransform(false);
    }
};

// ═══════════════════════════════════════
// SECTION: Note State Management
// ═══════════════════════════════════════

function updateCollapsedState(noteEl, data) {
    const children = getChildren(data.id);
    const countSpan = noteEl.querySelector('.collapsed-count');

    noteEl.classList.toggle('collapsed', !!data.isCollapsed);
    if (data.isCollapsed && countSpan) countSpan.textContent = children.length;

    children.forEach(child => {
        const el = getNoteEl(child.id);
        if (el) el.style.display = data.isCollapsed ? 'none' : 'flex';
    });

    // Hide shuffle preview when uncollapsing
    if (!data.isCollapsed) {
        const preview = noteEl.querySelector('.shuffle-preview');
        if (preview) {
            preview.classList.remove('active');
            preview.classList.remove('revealed');
        }
    }
}

function bringToFront(el, data) {
    highestZ++;
    el.style.zIndex = highestZ;
    data.z = highestZ;
    el.classList.add('active-focus');
}

function refreshStacks() {
    notes.filter(n => n.isPinRoot).forEach(root => {
        const children = getChildren(root.id);
        let cumOffset = noteHeight(root);

        children.forEach((child, i) => {
            const el = getNoteEl(child.id);
            if (el && activeNote?.id !== child.id) {
                child.x = root.x;
                child.y = root.y + cumOffset + 10 * (i + 1);
                el.style.left = child.x + 'px';
                el.style.top = child.y + 'px';
                cumOffset += noteHeight(child);
            }
        });
    });
}

// ═══════════════════════════════════════
// SECTION: Markdown Export / Import
// ═══════════════════════════════════════

function generateMarkdown() {
    const mainItems = sortByPosition(notes.filter(n => n.isPinRoot || !n.parentPinId));
    let markdown = '';
    const seen = new Set();

    mainItems.forEach(item => {
        if (seen.has(item.id)) return;
        seen.add(item.id);

        if (item.isPinRoot) {
            markdown += `## ${item.content || '(Empty Pin)'}\n\n`;
            getChildren(item.id).forEach(child => {
                markdown += `### ${child.content || '(Empty Note)'}\n\n`;
                seen.add(child.id);
            });
        } else {
            markdown += `### ${item.content || '(Empty Note)'}\n\n`;
        }
    });

    return markdown.trim();
}

let exportFormat = 'md';
let importFormat = 'md';

function refreshExportText() {
    exportText.value = exportFormat === 'md' ? generateMarkdown() : generateCsv();
}

function setExportFormat(fmt) {
    exportFormat = fmt;
    const mdTab = $('export-md-tab');
    const csvTab = $('export-csv-tab');
    if (fmt === 'md') {
        mdTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-purple-500 text-white';
        csvTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-gray-200 text-gray-600';
    } else {
        mdTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-gray-200 text-gray-600';
        csvTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-purple-500 text-white';
    }
    refreshExportText();
}

function setImportFormat(fmt) {
    importFormat = fmt;
    const mdTab = $('import-md-tab');
    const csvTab = $('import-csv-tab');
    const textArea = importText;
    const fileArea = $('import-file-area');
    const hint = $('import-hint');
    if (fmt === 'md') {
        mdTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-emerald-500 text-white';
        csvTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-gray-200 text-gray-600';
        textArea.style.display = '';
        fileArea.style.display = 'none';
        hint.textContent = 'Use ## for pinned notes, ### for stacked notes';
    } else {
        mdTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-gray-200 text-gray-600';
        csvTab.className = 'flex-1 py-1.5 px-3 text-sm font-semibold rounded-lg transition-all bg-emerald-500 text-white';
        textArea.style.display = 'none';
        fileArea.style.display = '';
        hint.textContent = 'CSV format: category, word, definition';
    }
}

function toggleExport() {
    const isOpen = exportPanel.style.display === 'block';
    exportPanel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) refreshExportText();
}

function toggleImport() {
    const isOpen = importPanel.style.display === 'block';
    importPanel.style.display = isOpen ? 'none' : 'block';
}

function doImport(replaceAll) {
    if (importFormat === 'md') {
        importMarkdown(replaceAll);
    } else {
        csvReplaceAll = !!replaceAll;
        $('csv-file-input').value = '';
        $('csv-file-input').click();
    }
}

function downloadExport() {
    if (exportFormat === 'csv') {
        downloadCsvExport();
    } else {
        const blob = new Blob([generateMarkdown()], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bibo-notes.md';
        a.click();
        URL.revokeObjectURL(url);
    }
}

function importMarkdown(replaceAll) {
    const markdown = importText.value.trim();
    if (!markdown) return;

    if (replaceAll) {
        notes.forEach(n => { const el = getNoteEl(n.id); if (el) el.remove(); });
        notes = [];
    }

    // Parse markdown into sections
    const sections = [];
    let cur = null;
    markdown.split('\n').forEach(line => {
        const t = line.trim();
        if ((t.startsWith('## ') || t === '##') && !t.startsWith('###')) {
            if (cur) sections.push(cur);
            cur = { type: 'pin', title: t.length > 2 ? t.substring(3).trim() : '', content: [] };
        } else if (t.startsWith('###') && !t.startsWith('####')) {
            if (cur) sections.push(cur);
            cur = { type: 'stack', title: t.length > 3 ? t.substring(4).trim() : '', content: [] };
        } else if (cur) {
            cur.content.push(line);
        }
    });
    if (cur) sections.push(cur);

    // Build notes from parsed sections
    let currentPin = null, stackOrder = 0, pinIndex = 0;

    const makeNote = (section, isPin) => {
        let fullContent = section.title;
        const body = section.content.join('\n').trim();
        if (body) fullContent += '\n' + body;

        const col = pinIndex % 4;
        const row = Math.floor(pinIndex / 4);
        return {
            id: Date.now() + Math.random() * 1000,
            x: isPin || !currentPin ? 100 + col * 260 : currentPin.x,
            y: isPin || !currentPin ? 80 + row * 400 : currentPin.y + 180,
            content: fullContent,
            z: ++highestZ,
            height: Math.min(400, 120 + body.split('\n').length * 20),
            isPinRoot: isPin,
            parentPinId: isPin ? null : currentPin?.id ?? null,
            stackOrder: isPin ? 0 : stackOrder++,
        };
    };

    sections.forEach(section => {
        const isPin = section.type === 'pin';
        const note = makeNote(section, isPin);
        notes.push(note);
        createNoteElement(note);
        if (isPin) { currentPin = note; stackOrder = 0; pinIndex++; }
        else if (!currentPin) pinIndex++;
    });

    refreshStacks();
    saveNotes();
    updateEmptyState();
    toggleImport();
    importText.value = '';
}

// ═══════════════════════════════════════
// SECTION: Snap / Stack Insertion Helpers
// ═══════════════════════════════════════

/** Calculate the total bottom Y of a root's stack */
function getStackBottomY(root) {
    let y = root.y + noteHeight(root);
    getChildren(root.id).forEach(child => { y += noteHeight(child) + 10; });
    return y;
}

function findStackInsertionIndex(root, draggedY, excludeId) {
    const children = getChildren(root.id, excludeId);
    if (children.length === 0) return 0;

    let cumY = root.y + noteHeight(root);
    const positions = children.map((child, i) => {
        const y = cumY + 10 * (i + 1);
        cumY += noteHeight(child);
        return { child, y };
    });

    if (draggedY < positions[0].y) return 0;
    for (let i = 0; i < positions.length; i++) {
        const next = positions[i + 1];
        if (!next) return i + 1;
        const mid = (positions[i].y + noteHeight(positions[i].child) + next.y) / 2;
        if (draggedY < mid) return i + 1;
    }
    return children.length;
}

/** Show a horizontal insertion line at (x, y) on the canvas */
function showInsertionLine(x, y) {
    hideInsertionPreview();
    insertionPreview = document.createElement('div');
    insertionPreview.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:240px;height:4px;` +
        `background:#4f46e5;border-radius:2px;z-index:999999;pointer-events:none;` +
        `box-shadow:0 0 8px rgba(79,70,229,0.5)`;
    canvas.appendChild(insertionPreview);
}

function showInsertionPreview(root, insertIndex, excludeId) {
    const children = getChildren(root.id, excludeId);
    let previewY;

    if (insertIndex === 0) {
        previewY = root.y + noteHeight(root) + 5;
    } else if (insertIndex <= children.length) {
        let co = root.y + noteHeight(root);
        for (let i = 0; i < insertIndex && i < children.length; i++) {
            co += noteHeight(children[i]) + 10;
        }
        previewY = co;
    } else {
        previewY = root.y + noteHeight(root) + 50;
    }

    showInsertionLine(root.x, previewY);
}

function hideInsertionPreview() {
    if (insertionPreview) { insertionPreview.remove(); insertionPreview = null; }
}

// ═══════════════════════════════════════
// SECTION: Note Element Creation
// ═══════════════════════════════════════

function createNoteElement(data) {
    const noteEl = document.createElement('div');
    noteEl.className =
        'note' +
        (data.isPinRoot ? ' is-pin-root' : '') +
        (data.parentPinId ? ' is-stacked' : '');
    noteEl.id = 'note-' + data.id;
    noteEl.style.left = data.x + 'px';
    noteEl.style.top = data.y + 'px';
    noteEl.style.zIndex = data.z || 1;
    noteEl.style.height = noteHeight(data) + 'px';
    noteEl.style.width = noteWidth(data) + 'px';

    const { word, def } = splitContent(data.content);

    noteEl.innerHTML = `
        <div class="note-header">
            <span class="drag-handle">Sticky</span>
            <button class="header-btn pin-btn ${data.isPinRoot ? 'active-pin' : ''}" title="Toggle Pin">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="4"/>
                    <path d="M12 9 L12 20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    <circle cx="12" cy="20" r="1.5"/>
                </svg>
            </button>
            <button class="header-btn shuffle-btn" title="Shuffle & Preview">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
            </button>
            <button class="header-btn delete-btn hover:text-red-600">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        </div>
        <div class="note-body">
            <textarea class="note-word" placeholder="Word / term...">${word}</textarea>
            <div class="note-divider"><span class="note-divider-label">def ↓</span></div>
            <textarea class="note-def" placeholder="Definition...">${def}</textarea>
        </div>
        <div class="resize-handle"></div>
        <div class="shuffle-preview">
            <div class="shuffle-resize-handle"></div>
            <span class="shuffle-label">🎲 random note</span>
            <div class="shuffle-word-area"></div>
            <div class="shuffle-def-area"></div>
        </div>
        <div class="resize-handle-h"></div>
        <div class="collapsed-indicator">\u25BC <span class="collapsed-count">0</span> collapsed</div>`;

    const header = noteEl.querySelector('.note-header');
    const pinBtn = noteEl.querySelector('.pin-btn');
    const resizeHandle = noteEl.querySelector('.resize-handle');

    // ─ Drag start (shared by mouse & touch) ─
    const startDrag = (cx, cy) => {
        bringToFront(noteEl, data);
        activeNote = data;
        const rect = noteEl.getBoundingClientRect();
        offset.x = cx - rect.left;
        offset.y = cy - rect.top;
        if (data.parentPinId) {
            data.parentPinId = null;
            noteEl.classList.remove('is-stacked');
            refreshStacks();
        }
    };

    // ─ Double-click to collapse (mouse only) ─
    let lastClickTime = 0, hasMoved = false, startPos = { x: 0, y: 0 };

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.header-btn')) return;
        hasMoved = false;
        startPos = { x: e.clientX, y: e.clientY };
        startDrag(e.clientX, e.clientY);
    });
    header.addEventListener('mousemove', (e) => {
        if (activeNote === data && Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y) > 5) {
            hasMoved = true;
        }
    });
    header.addEventListener('mouseup', (e) => {
        if (e.target.closest('.header-btn') || hasMoved) return;
        const now = Date.now();
        if (now - lastClickTime < DOUBLE_CLICK_MS && data.isPinRoot && getChildren(data.id).length > 0) {
            data.isCollapsed = !data.isCollapsed;
            updateCollapsedState(noteEl, data);
            saveNotes();
            lastClickTime = 0;
        } else {
            lastClickTime = now;
        }
    });
    header.addEventListener('touchstart', (e) => {
        if (e.target.closest('.header-btn')) return;
        startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    // ─ Collapsed indicator click ─
    noteEl.querySelector('.collapsed-indicator').addEventListener('click', (e) => {
        e.stopPropagation();
        data.isCollapsed = false;
        updateCollapsedState(noteEl, data);
        saveNotes();
    });
    if (data.isCollapsed) setTimeout(() => updateCollapsedState(noteEl, data), 0);

    // ─ Resize ─
    const startResize = (cy) => {
        resizingNote = data;
        noteEl.classList.add('is-resizing');
        bringToFront(noteEl, data);
        resizeStart.y = cy;
        resizeStart.height = noteHeight(data);
    };
    resizeHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); startResize(e.clientY); });
    resizeHandle.addEventListener('touchstart', (e) => { e.stopPropagation(); startResize(e.touches[0].clientY); }, { passive: true });

    // ─ Horizontal resize ─
    const resizeHandleH = noteEl.querySelector('.resize-handle-h');
    let hResizing = false, hResizeStartX = 0, hResizeStartW = 0;

    const startHResize = (cx) => {
        hResizing = true;
        hResizeStartX = cx;
        hResizeStartW = noteWidth(data);
        noteEl.classList.add('is-resizing');
        bringToFront(noteEl, data);
        const onMove = (ev) => {
            if (!hResizing) return;
            const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            data.width = Math.max(MIN_NOTE_WIDTH, Math.min(MAX_NOTE_WIDTH, hResizeStartW + clientX - hResizeStartX));
            noteEl.style.width = data.width + 'px';
        };
        const onEnd = () => {
            hResizing = false;
            noteEl.classList.remove('is-resizing', 'active-focus');
            saveNotes();
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    };
    resizeHandleH.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); startHResize(e.clientX); });
    resizeHandleH.addEventListener('touchstart', (e) => { e.stopPropagation(); startHResize(e.touches[0].clientX); }, { passive: false });

    // ─ Shuffle: flashcard-style (word → reveal def → next card) ─
    const shuffleBtn = noteEl.querySelector('.shuffle-btn');
    const shufflePreview = noteEl.querySelector('.shuffle-preview');
    const shuffleWordArea = noteEl.querySelector('.shuffle-word-area');
    const shuffleDefArea = noteEl.querySelector('.shuffle-def-area');
    let shuffleState = 'idle'; // idle → word → revealed → (next click → word again)

    shuffleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const children = getChildren(data.id);
        if (!data.isPinRoot || children.length === 0) return;

        // Collapse the stack
        data.isCollapsed = true;
        updateCollapsedState(noteEl, data);

        if (shuffleState === 'word') {
            // Reveal the definition
            shufflePreview.classList.add('revealed');
            shuffleState = 'revealed';
        } else {
            // Pick a new random child (from idle or revealed)
            const randomChild = children[Math.floor(Math.random() * children.length)];
            const parts = splitContent(randomChild.content);
            shuffleWordArea.textContent = parts.word || '(Empty)';
            shuffleDefArea.textContent = parts.def || '(No definition)';
            shufflePreview.classList.remove('revealed');
            shufflePreview.classList.add('active');
            shuffleState = 'word';
        }

        saveNotes();
    });

    // ─ Shuffle preview resize (drag top edge up/down) ─
    const shuffleResizeHandle = noteEl.querySelector('.shuffle-resize-handle');
    let shuffleResizing = false, shuffleResizeStartY = 0, shuffleResizeStartTop = 0;

    const startShuffleResize = (cy) => {
        shuffleResizing = true;
        shuffleResizeStartY = cy;
        shuffleResizeStartTop = parseFloat(shufflePreview.style.top) || 50;
        e_preventAll();
    };

    const e_preventAll = () => {
        const onMove = (ev) => {
            if (!shuffleResizing) return;
            const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            const noteRect = noteEl.getBoundingClientRect();
            const noteH = noteRect.height;
            const deltaY = clientY - shuffleResizeStartY;
            const deltaPct = (deltaY / noteH) * 100;
            const newTop = Math.max(10, Math.min(90, shuffleResizeStartTop + deltaPct));
            shufflePreview.style.top = newTop + '%';
        };
        const onEnd = () => {
            shuffleResizing = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    };

    shuffleResizeHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        shuffleResizeStartY = e.clientY;
        shuffleResizeStartTop = parseFloat(shufflePreview.style.top) || 50;
        shuffleResizing = true;
        e_preventAll();
    });
    shuffleResizeHandle.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        shuffleResizeStartY = e.touches[0].clientY;
        shuffleResizeStartTop = parseFloat(shufflePreview.style.top) || 50;
        shuffleResizing = true;
        e_preventAll();
    }, { passive: false });

    // ─ Pin toggle ─
    const divider = noteEl.querySelector('.note-divider');
    const defArea = noteEl.querySelector('.note-def');

    const updatePinVisuals = () => {
        const wordInput = noteEl.querySelector('.note-word');
        if (data.isPinRoot) {
            divider.style.display = 'none';
            defArea.style.display = 'none';
            wordInput.placeholder = 'Category...';
        } else {
            divider.style.display = '';
            defArea.style.display = '';
            wordInput.placeholder = 'Word / term...';
        }
    };
    updatePinVisuals();

    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (data.isPinRoot && getChildren(data.id).length > 0) return; // can't unpin with children
        // Can't pin a note that has a definition
        if (!data.isPinRoot && defArea.value.trim()) return;
        data.isPinRoot = !data.isPinRoot;
        noteEl.classList.toggle('is-pin-root', data.isPinRoot);
        pinBtn.classList.toggle('active-pin', data.isPinRoot);
        if (data.isPinRoot) { data.parentPinId = null; noteEl.classList.remove('is-stacked'); }
        updatePinVisuals();
        refreshStacks();
        saveNotes();
    });

    // ─ Content editing (word + definition) ─
    const wordArea = noteEl.querySelector('.note-word');
    const updateContent = () => {
        data.content = joinContent(wordArea.value, defArea.value);
        saveNotes();
    };
    wordArea.addEventListener('input', updateContent);
    defArea.addEventListener('input', updateContent);

    // ─ Divider drag (resize word vs definition area) ─
    divider.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const body = noteEl.querySelector('.note-body');
        const startY = e.clientY;
        const startWordH = wordArea.offsetHeight;
        const startDefH = defArea.offsetHeight;
        const totalH = startWordH + startDefH;
        const onMove = (ev) => {
            const delta = ev.clientY - startY;
            const newWordH = Math.max(20, Math.min(totalH - 20, startWordH + delta));
            const newDefH = totalH - newWordH;
            wordArea.style.flex = `0 0 ${newWordH}px`;
            defArea.style.flex = `0 0 ${newDefH}px`;
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    divider.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        const startY = e.touches[0].clientY;
        const startWordH = wordArea.offsetHeight;
        const startDefH = defArea.offsetHeight;
        const totalH = startWordH + startDefH;
        const onMove = (ev) => {
            const delta = ev.touches[0].clientY - startY;
            const newWordH = Math.max(20, Math.min(totalH - 20, startWordH + delta));
            const newDefH = totalH - newWordH;
            wordArea.style.flex = `0 0 ${newWordH}px`;
            defArea.style.flex = `0 0 ${newDefH}px`;
        };
        const onUp = () => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        };
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }, { passive: false });

    // ─ Delete ─
    noteEl.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        notes = notes.filter(n => n.id !== data.id);
        noteEl.remove();
        refreshStacks();
        saveNotes();
        updateEmptyState();
    });

    canvas.appendChild(noteEl);
}

// ═══════════════════════════════════════
// SECTION: Drag & Drop Logic
// ═══════════════════════════════════════

function handleDragMove(clientX, clientY) {
    // Handle resize
    if (resizingNote) {
        const el = getNoteEl(resizingNote.id);
        resizingNote.height = Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, resizeStart.height + clientY - resizeStart.y));
        el.style.height = resizingNote.height + 'px';
        return;
    }

    if (!activeNote) return;
    const el = getNoteEl(activeNote.id);

    // Move note (convert screen → canvas coords)
    const pos = screenToCanvas(clientX - offset.x, clientY - offset.y);
    activeNote.x = pos.x;
    activeNote.y = pos.y;
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';

    // Find closest snap target among pin roots
    let bestRoot = null, bestDist = Infinity;
    notes.filter(n => n.isPinRoot && n.id !== activeNote.id).forEach(root => {
        const xDist = Math.abs(root.x - activeNote.x);
        const snapPadding = root.isCollapsed ? 30 : 100;
        const stackBottom = root.isCollapsed
            ? root.y + noteHeight(root)
            : getStackBottomY(root);

        if (xDist < SNAP_X_THRESHOLD && activeNote.y >= root.y - SNAP_Y_ABOVE && activeNote.y <= stackBottom + snapPadding) {
            const dist = Math.hypot(xDist, Math.abs(activeNote.y - root.y));
            if (dist < bestDist) { bestDist = dist; bestRoot = root; }
        }
    });

    // Show/hide snap preview
    hoverRoot = bestRoot;
    if (bestRoot) {
        if (bestRoot.isCollapsed) {
            hoverInsertIndex = getChildren(bestRoot.id).length;
            showInsertionLine(bestRoot.x, bestRoot.y + noteHeight(bestRoot) + 5);
        } else {
            hoverInsertIndex = findStackInsertionIndex(bestRoot, activeNote.y, activeNote.id);
            showInsertionPreview(bestRoot, hoverInsertIndex, activeNote.id);
        }
    } else {
        hideInsertionPreview();
    }
    el.classList.toggle('snap-preview', !!bestRoot);
}

function endMove() {
    // End resize
    if (resizingNote) {
        getNoteEl(resizingNote.id).classList.remove('is-resizing', 'active-focus');
        refreshStacks();
        saveNotes();
        resizingNote = null;
        return;
    }

    if (!activeNote) return;
    const el = getNoteEl(activeNote.id);
    el.classList.remove('active-focus', 'snap-preview');
    hideInsertionPreview();

    // Snap into a stack
    if (hoverRoot) {
        // Prevent pinned root with children from becoming a child
        if (activeNote.isPinRoot && getChildren(activeNote.id).length > 0) {
            hoverRoot = null;
            hoverInsertIndex = 0;
            refreshStacks();
            saveNotes();
            activeNote = null;
            return;
        }

        // Reorder existing children to make room
        getChildren(hoverRoot.id, activeNote.id).forEach((child, i) => {
            child.stackOrder = i >= hoverInsertIndex ? i + 1 : i;
        });

        // Attach to root
        activeNote.parentPinId = hoverRoot.id;
        activeNote.isPinRoot = false;
        activeNote.stackOrder = hoverInsertIndex;
        el.classList.remove('is-pin-root');
        el.classList.add('is-stacked');
        const pinBtn = el.querySelector('.pin-btn');
        if (pinBtn) pinBtn.classList.remove('active-pin');
    }

    hoverRoot = null;
    hoverInsertIndex = 0;
    refreshStacks();
    saveNotes();
    activeNote = null;
}

// ═══════════════════════════════════════
// SECTION: Button Actions
// ═══════════════════════════════════════

// Add note
$('add-btn').addEventListener('click', () => {
    const newNote = {
        id: Date.now(),
        x: (window.innerWidth / 2 - panX) + (Math.random() * 60 - 30),
        y: (window.innerHeight / 2 - panY) + (Math.random() * 60 - 30),
        content: '',
        z: ++highestZ,
        height: DEFAULT_HEIGHT,
        isPinRoot: false,
        parentPinId: null,
        stackOrder: 0,
    };
    notes.push(newNote);
    createNoteElement(newNote);
    saveNotes();
    updateEmptyState();
});

$('export-btn').addEventListener('click', toggleExport);
$('import-btn').addEventListener('click', toggleImport);

// ═══════════════════════════════════════
// SECTION: CSV Export / Import
// ═══════════════════════════════════════

function escapeCsvField(str) {
    if (!str) return '';
    str = str.replace(/\n/g, '\\n');
    if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function generateCsv() {
    const rows = ['category,word,definition'];
    const mainItems = sortByPosition(notes.filter(n => n.isPinRoot || !n.parentPinId));
    const seen = new Set();

    mainItems.forEach(item => {
        if (seen.has(item.id)) return;
        seen.add(item.id);

        if (item.isPinRoot) {
            const category = item.content || '';
            const children = getChildren(item.id);
            if (children.length === 0) {
                rows.push(escapeCsvField(category) + ',,');
            } else {
                children.forEach(child => {
                    const parts = splitContent(child.content);
                    rows.push(
                        escapeCsvField(category) + ',' +
                        escapeCsvField(parts.word) + ',' +
                        escapeCsvField(parts.def)
                    );
                    seen.add(child.id);
                });
            }
        } else {
            const parts = splitContent(item.content);
            rows.push(',' + escapeCsvField(parts.word) + ',' + escapeCsvField(parts.def));
        }
    });

    return rows.join('\n');
}

function downloadCsvExport() {
    const csv = generateCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bibo-notes.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') { inQuotes = false; }
            else { current += ch; }
        } else {
            if (ch === '"') { inQuotes = true; }
            else if (ch === ',') { fields.push(current); current = ''; }
            else { current += ch; }
        }
    }
    fields.push(current);
    return fields.map(f => f.replace(/\\n/g, '\n'));
}

let csvReplaceAll = false;

function importCsvFile(replaceAll) {
    csvReplaceAll = !!replaceAll;
    const input = $('csv-file-input');
    input.value = '';
    input.click();
}

$('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const text = ev.target.result;
        processCsvImport(text, csvReplaceAll);
    };
    reader.readAsText(file);
});

function processCsvImport(text, replaceAll) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return; // need header + at least 1 row

    if (replaceAll) {
        notes.forEach(n => { const el = getNoteEl(n.id); if (el) el.remove(); });
        notes = [];
    }

    // Group by category
    const categories = new Map(); // category -> [{word, def}]
    const uncategorized = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const category = (fields[0] || '').trim();
        const word = (fields[1] || '').trim();
        const def = (fields[2] || '').trim();
        if (!word && !def && !category) continue;

        if (category) {
            if (!categories.has(category)) categories.set(category, []);
            categories.get(category).push({ word, def });
        } else {
            uncategorized.push({ word, def });
        }
    }

    let pinIndex = 0;

    // Create pinned categories + children
    categories.forEach((cards, category) => {
        const col = pinIndex % 4;
        const row = Math.floor(pinIndex / 4);

        // Create pin root
        const pin = {
            id: Date.now() + Math.random() * 1000,
            x: 100 + col * 260,
            y: 80 + row * 400,
            content: category,
            z: ++highestZ,
            height: DEFAULT_HEIGHT,
            isPinRoot: true,
            parentPinId: null,
            stackOrder: 0,
        };
        notes.push(pin);
        createNoteElement(pin);

        // Create children
        cards.forEach((card, ci) => {
            const child = {
                id: Date.now() + Math.random() * 1000 + ci + 1,
                x: pin.x,
                y: pin.y + DEFAULT_HEIGHT + 10 * (ci + 1),
                content: joinContent(card.word, card.def),
                z: ++highestZ,
                height: DEFAULT_HEIGHT,
                isPinRoot: false,
                parentPinId: pin.id,
                stackOrder: ci,
            };
            notes.push(child);
            createNoteElement(child);
        });

        pinIndex++;
    });

    // Create uncategorized notes
    uncategorized.forEach((card, i) => {
        const col = (pinIndex + i) % 4;
        const row = Math.floor((pinIndex + i) / 4);
        const note = {
            id: Date.now() + Math.random() * 1000 + i + 100,
            x: 100 + col * 260,
            y: 80 + row * 400,
            content: joinContent(card.word, card.def),
            z: ++highestZ,
            height: DEFAULT_HEIGHT,
            isPinRoot: false,
            parentPinId: null,
            stackOrder: 0,
        };
        notes.push(note);
        createNoteElement(note);
    });

    refreshStacks();
    saveNotes();
    updateEmptyState();
    toggleImport();
}

// ═══════════════════════════════════════
// SECTION: Auto-Organize
// ═══════════════════════════════════════

$('organize-btn')?.addEventListener('click', () => {
    if (notes.length === 0) return;

    // Group notes: each pin root with its children, standalone notes alone
    const mainItems = sortByPosition(notes.filter(n => n.isPinRoot || !n.parentPinId));
    const seen = new Set();
    const groups = [];

    mainItems.forEach(item => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        const children = item.isPinRoot ? getChildren(item.id) : [];
        children.forEach(c => seen.add(c.id));
        groups.push({ root: item, children });
    });

    // Separate pinned groups from standalone notes
    const pinnedGroups = groups.filter(g => g.root.isPinRoot);
    const standaloneGroups = groups.filter(g => !g.root.isPinRoot);

    const COL_WIDTH = 260, START_X = 60, START_Y = 160;

    // Reset all note widths to default
    notes.forEach(n => {
        delete n.width;
        const el = getNoteEl(n.id);
        if (el) el.style.width = DEFAULT_WIDTH + 'px';
    });

    // Layout pinned groups in first row
    pinnedGroups.forEach((group, gi) => {
        const { root, children } = group;
        root.x = START_X + gi * COL_WIDTH;
        root.y = START_Y;
        const rootEl = getNoteEl(root.id);
        if (rootEl) { rootEl.style.left = root.x + 'px'; rootEl.style.top = root.y + 'px'; }

        // Auto-collapse pinned notes that have children
        if (children.length > 0) {
            root.isCollapsed = true;
            if (rootEl) updateCollapsedState(rootEl, root);
        }

        // Position children
        let childY = root.y + noteHeight(root);
        children.forEach((child, i) => {
            child.x = root.x;
            child.y = childY + 10 * (i + 1);
            const el = getNoteEl(child.id);
            if (el) { el.style.left = child.x + 'px'; el.style.top = child.y + 'px'; }
            childY += noteHeight(child);
        });
    });

    // Layout standalone notes in a row below pinned groups
    const standaloneStartY = START_Y + (pinnedGroups.length > 0 ? DEFAULT_HEIGHT + 80 : 0);
    standaloneGroups.forEach((group, si) => {
        const { root } = group;
        const col = si % 4;
        const row = Math.floor(si / 4);
        root.x = START_X + col * COL_WIDTH;
        root.y = standaloneStartY + row * (DEFAULT_HEIGHT + 30);
        const rootEl = getNoteEl(root.id);
        if (rootEl) { rootEl.style.left = root.x + 'px'; rootEl.style.top = root.y + 'px'; }
    });

    refreshStacks();
    saveNotes();
    panX = 0;
    panY = 0;
    applyCanvasTransform(true);
    savePan();
});

// ═══════════════════════════════════════
// SECTION: Dark Mode
// ═══════════════════════════════════════

let isDarkMode = localStorage.getItem('bibo-dark-mode') === 'true';

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('dark-mode', isDarkMode);
    localStorage.setItem('bibo-dark-mode', isDarkMode);
}

if (isDarkMode) document.body.classList.add('dark-mode');