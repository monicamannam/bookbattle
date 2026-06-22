const TABLE_NAME = "bookbattle_items";
const LOCAL_STORAGE_KEY = "bookbattle-ranking-items";
const RANK_STEP = 1000;

const entryForm = document.querySelector("#entryForm");
const nameInput = document.querySelector("#nameInput");
const imageInput = document.querySelector("#imageInput");
const rankingList = document.querySelector("#rankingList");
const rankingItemTemplate = document.querySelector("#rankingItemTemplate");

let supabaseClient = null;
let hasLoadedRemoteConfig = false;
let items = [];
let isBusy = false;
let activeSort = null;

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  const imageUrl = imageInput.value.trim();

  if (!name || !imageUrl) {
    return;
  }

  await runWithBusyState(async () => {
    const nextRank = items.length ? Math.max(...items.map((item) => item.rank)) + RANK_STEP : RANK_STEP;
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
  });
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
  });
}

async function reorderItems(fromIndex, toIndex) {
  const previousItems = items.map((item) => ({ ...item }));
  const movedItemId = items[fromIndex].id;

  reorderItemsLocally(fromIndex, toIndex);
  renderItems();

  try {
    await persistReorderedItem(movedItemId);
  } catch (error) {
    items = previousItems;
    renderItems();
    throw error;
  }
}

async function persistReorderedItem(movedItemId) {
  const movedIndex = items.findIndex((item) => item.id === movedItemId);
  const movedItem = items[movedIndex];
  const previousItem = items[movedIndex - 1] || null;
  const nextItem = items[movedIndex + 1] || null;
  const nextRank = getRankBetween(previousItem, nextItem);

  if (!movedItem) {
    return;
  }

  if (nextRank === null) {
    items = getRebalancedItems(items);
    renderItems();
    await persistAllRanks(items);
    return;
  }

  movedItem.rank = nextRank;

  if (!supabaseClient) {
    saveLocalItems();
    return;
  }

  const { error } = await supabaseClient
    .from(TABLE_NAME)
    .update({ rank: movedItem.rank })
    .eq("id", movedItem.id);

  if (error) {
    throw error;
  }
}

async function persistAllRanks(rankedItems) {
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

function getRankBetween(previousItem, nextItem) {
  if (!previousItem && !nextItem) {
    return RANK_STEP;
  }

  if (!previousItem) {
    const candidateRank = nextItem.rank - RANK_STEP;
    return candidateRank > 0 ? candidateRank : null;
  }

  if (!nextItem) {
    return previousItem.rank + RANK_STEP;
  }

  if (nextItem.rank - previousItem.rank <= 1) {
    return null;
  }

  return Math.floor((previousItem.rank + nextItem.rank) / 2);
}

function getRebalancedItems(rawItems) {
  return rawItems.map((item, index) => ({
    ...item,
    rank: (index + 1) * RANK_STEP,
  }));
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
    const dragHandle = row.querySelector(".drag-handle");
    const image = row.querySelector(".entry-image");
    const title = row.querySelector("h3");
    const upButton = row.querySelector(".move-up");
    const downButton = row.querySelector(".move-down");

    row.dataset.itemId = item.id;
    row.classList.toggle("is-sorting", activeSort?.itemId === item.id);
    row.querySelector(".rank-number").textContent = String(index + 1).padStart(2, "0");
    image.src = item.image_url;
    image.alt = item.name;
    image.loading = "lazy";
    title.textContent = item.name;

    dragHandle.disabled = isBusy;
    dragHandle.addEventListener("pointerdown", (event) => beginPointerSort(event, item.id));
    upButton.disabled = index === 0 || isBusy;
    downButton.disabled = index === items.length - 1 || isBusy;
    upButton.addEventListener("click", () => moveItem(item.id, -1));
    downButton.addEventListener("click", () => moveItem(item.id, 1));

    rankingList.append(row);
  });
}

function beginPointerSort(event, itemId) {
  if (isBusy || event.button !== 0) {
    return;
  }

  event.preventDefault();
  activeSort = {
    itemId,
    previousItems: items.map((item) => ({ ...item })),
  };
  document.body.classList.add("is-reordering");
  renderItems();

  window.addEventListener("pointermove", handlePointerSortMove);
  window.addEventListener("pointerup", endPointerSort, { once: true });
  window.addEventListener("pointercancel", cancelPointerSort, { once: true });
}

function handlePointerSortMove(event) {
  if (!activeSort) {
    return;
  }

  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest(".ranking-item");

  if (!row || !rankingList.contains(row) || row.dataset.itemId === activeSort.itemId) {
    return;
  }

  const currentIndex = items.findIndex((item) => item.id === activeSort.itemId);
  const overIndex = items.findIndex((item) => item.id === row.dataset.itemId);

  if (currentIndex < 0 || overIndex < 0) {
    return;
  }

  const rect = row.getBoundingClientRect();
  const isAfter = event.clientY > rect.top + rect.height / 2;
  let targetIndex = isAfter ? overIndex + 1 : overIndex;

  if (targetIndex > currentIndex) {
    targetIndex -= 1;
  }

  targetIndex = Math.max(0, Math.min(targetIndex, items.length - 1));

  if (currentIndex !== targetIndex) {
    reorderItemsLocally(currentIndex, targetIndex);
    renderItems();
  }
}

async function endPointerSort() {
  window.removeEventListener("pointermove", handlePointerSortMove);
  window.removeEventListener("pointercancel", cancelPointerSort);

  if (!activeSort) {
    return;
  }

  const previousItems = activeSort.previousItems;
  const movedItemId = activeSort.itemId;
  const hasChanged = previousItems.some((item, index) => item.id !== items[index]?.id);

  activeSort = null;
  document.body.classList.remove("is-reordering");
  renderItems();

  if (!hasChanged) {
    return;
  }

  await runWithBusyState(async () => {
    try {
      await persistReorderedItem(movedItemId);
    } catch (error) {
      items = previousItems;
      renderItems();
      throw error;
    }
  });
}

function cancelPointerSort() {
  window.removeEventListener("pointermove", handlePointerSortMove);
  window.removeEventListener("pointerup", endPointerSort);

  if (activeSort) {
    items = activeSort.previousItems;
  }

  activeSort = null;
  document.body.classList.remove("is-reordering");
  renderItems();
}

function reorderItemsLocally(fromIndex, toIndex) {
  const reorderedItems = [...items];
  const [movedItem] = reorderedItems.splice(fromIndex, 1);

  reorderedItems.splice(toIndex, 0, movedItem);
  items = reorderedItems;
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
  rankingList.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled;
  });
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
  const rankedItems = sortItems(
    rawItems.map((item, index) => ({
      ...item,
      rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : (index + 1) * RANK_STEP,
    })),
  );

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
