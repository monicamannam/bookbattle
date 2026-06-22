const TABLE_NAME = "bookbattle_items";
const LOCAL_STORAGE_KEY = "bookbattle-ranking-items";

const statusText = document.querySelector("#statusText");
const entryForm = document.querySelector("#entryForm");
const nameInput = document.querySelector("#nameInput");
const imageInput = document.querySelector("#imageInput");
const rankingList = document.querySelector("#rankingList");
const refreshButton = document.querySelector("#refreshButton");
const rankingItemTemplate = document.querySelector("#rankingItemTemplate");

let supabaseClient = null;
let hasLoadedRemoteConfig = false;
let items = [];
let isBusy = false;
let draggedItemId = null;

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  const imageUrl = imageInput.value.trim();

  if (!name || !imageUrl) {
    setStatus("Add a name and image URL first.");
    return;
  }

  await runWithBusyState(async () => {
    const nextRank = items.length ? Math.max(...items.map((item) => item.rank)) + 1 : 1;
    const newItem = {
      name,
      image_url: imageUrl,
      rank: nextRank,
    };

    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from(TABLE_NAME)
        .insert(newItem)
        .select()
        .single();

      if (error) {
        throw error;
      }

      items = sortItems([...items, data]);
    } else {
      items = sortItems([
        ...items,
        {
          ...newItem,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
        },
      ]);
      saveLocalItems();
    }

    entryForm.reset();
    renderItems();
    setStatus(`Added "${name}" at the bottom.`);
  });
});

refreshButton.addEventListener("click", () => {
  loadItems();
});

async function loadItems() {
  await runWithBusyState(async () => {
    await loadRemoteConfig();

    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from(TABLE_NAME)
        .select("id,name,image_url,rank,created_at")
        .order("rank", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      items = normalizeRanks(data || []);
    } else {
      items = normalizeRanks(loadLocalItems());
    }

    renderItems();
    setStatus(getModeStatus());
  });
}

async function moveItem(itemId, direction) {
  const currentIndex = items.findIndex((item) => item.id === itemId);
  const targetIndex = currentIndex + direction;

  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= items.length) {
    return;
  }

  await runWithBusyState(async () => {
    await reorderItems(currentIndex, targetIndex);
    setStatus(`Moved "${items[targetIndex].name}" ${direction < 0 ? "up" : "down"}.`);
  });
}

async function moveDraggedItem(dropIndex) {
  const currentIndex = items.findIndex((item) => item.id === draggedItemId);

  if (currentIndex < 0) {
    return;
  }

  let targetIndex = dropIndex;

  if (targetIndex > currentIndex) {
    targetIndex -= 1;
  }

  targetIndex = Math.max(0, Math.min(targetIndex, items.length - 1));

  if (currentIndex === targetIndex) {
    return;
  }

  await runWithBusyState(async () => {
    await reorderItems(currentIndex, targetIndex);
    setStatus(`Moved "${items[targetIndex].name}" to rank ${targetIndex + 1}.`);
  });
}

async function reorderItems(fromIndex, toIndex) {
  const previousItems = items.map((item) => ({ ...item }));
  const reorderedItems = [...items];
  const [movedItem] = reorderedItems.splice(fromIndex, 1);

  reorderedItems.splice(toIndex, 0, movedItem);
  items = reorderedItems.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
  renderItems();

  try {
    await persistRanks(items);
  } catch (error) {
    items = previousItems;
    renderItems();
    throw error;
  }
}

async function persistRanks(rankedItems) {
  if (!supabaseClient) {
    saveLocalItems();
    return;
  }

  const updates = await Promise.all(
    rankedItems.map((item) =>
      supabaseClient.from(TABLE_NAME).update({ rank: item.rank }).eq("id", item.id),
    ),
  );
  const failedUpdate = updates.find((result) => result.error);

  if (failedUpdate) {
    throw failedUpdate.error;
  }
}

function renderItems() {
  rankingList.replaceChildren();

  if (!items.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "No entries yet.";
    rankingList.append(emptyState);
    return;
  }

  items.forEach((item, index) => {
    const row = rankingItemTemplate.content.firstElementChild.cloneNode(true);
    const image = row.querySelector(".entry-image");
    const title = row.querySelector("h3");
    const upButton = row.querySelector(".move-up");
    const downButton = row.querySelector(".move-down");

    row.dataset.itemId = item.id;
    row.draggable = !isBusy;
    row.querySelector(".rank-number").textContent = String(index + 1).padStart(2, "0");
    image.src = item.image_url;
    image.alt = item.name;
    image.loading = "lazy";
    title.textContent = item.name;

    upButton.disabled = index === 0 || isBusy;
    downButton.disabled = index === items.length - 1 || isBusy;
    upButton.addEventListener("click", () => moveItem(item.id, -1));
    downButton.addEventListener("click", () => moveItem(item.id, 1));
    row.addEventListener("dragstart", (event) => handleDragStart(event, item.id));
    row.addEventListener("dragover", (event) => handleDragOver(event, row));
    row.addEventListener("dragleave", () => clearDropState(row));
    row.addEventListener("drop", (event) => handleDrop(event, row, index));
    row.addEventListener("dragend", handleDragEnd);

    rankingList.append(row);
  });
}

function handleDragStart(event, itemId) {
  if (isBusy) {
    event.preventDefault();
    return;
  }

  draggedItemId = itemId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", itemId);
  event.currentTarget.classList.add("is-dragging");
}

function handleDragOver(event, row) {
  if (!draggedItemId || row.dataset.itemId === draggedItemId) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearAllDropState();

  const rect = row.getBoundingClientRect();
  const isAfter = event.clientY > rect.top + rect.height / 2;
  row.classList.add(isAfter ? "drop-after" : "drop-before");
}

async function handleDrop(event, row, index) {
  event.preventDefault();

  const rect = row.getBoundingClientRect();
  const isAfter = event.clientY > rect.top + rect.height / 2;
  const dropIndex = isAfter ? index + 1 : index;

  clearAllDropState();
  await moveDraggedItem(dropIndex);
  draggedItemId = null;
}

function clearDropState(row) {
  row.classList.remove("drop-before", "drop-after");
}

function clearAllDropState() {
  rankingList.querySelectorAll(".ranking-item").forEach((row) => {
    row.classList.remove("is-dragging", "drop-before", "drop-after");
  });
}

function handleDragEnd() {
  draggedItemId = null;
  clearAllDropState();
}

async function runWithBusyState(action) {
  if (isBusy) {
    return;
  }

  isBusy = true;
  setControlsDisabled(true);

  try {
    await action();
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong.");
  } finally {
    isBusy = false;
    setControlsDisabled(false);
    renderItems();
  }
}

function setControlsDisabled(disabled) {
  entryForm.querySelectorAll("button, input").forEach((control) => {
    control.disabled = disabled;
  });
  refreshButton.disabled = disabled;
  rankingList.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled;
  });
}

function setStatus(message) {
  statusText.textContent = message;
}

function getModeStatus() {
  if (supabaseClient) {
    return items.length ? `${items.length} ranked entries loaded.` : "Add your first entry.";
  }

  return items.length ? `${items.length} ranked entries loaded.` : "Add your first entry.";
}

async function loadRemoteConfig() {
  if (hasLoadedRemoteConfig) {
    return;
  }

  hasLoadedRemoteConfig = true;

  try {
    const response = await fetch("/api/config", { cache: "no-store" });

    if (!response.ok) {
      return;
    }

    const config = await response.json();

    if (config.supabaseUrl && config.supabaseAnonKey) {
      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    }
  } catch {
    supabaseClient = null;
  }
}

function normalizeRanks(rawItems) {
  const rankedItems = sortItems(rawItems).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  if (!supabaseClient) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(rankedItems));
  }

  return rankedItems;
}

function sortItems(rawItems) {
  return [...rawItems].sort((first, second) => {
    if (first.rank !== second.rank) {
      return first.rank - second.rank;
    }

    return String(first.created_at || "").localeCompare(String(second.created_at || ""));
  });
}

function loadLocalItems() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLocalItems() {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(items));
}

loadItems();
