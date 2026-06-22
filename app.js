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
    const currentItem = items[currentIndex];
    const targetItem = items[targetIndex];
    const currentRank = currentItem.rank;
    const targetRank = targetItem.rank;

    currentItem.rank = targetRank;
    targetItem.rank = currentRank;
    items = sortItems(items);
    renderItems();

    if (supabaseClient) {
      const updates = await Promise.all([
        supabaseClient.from(TABLE_NAME).update({ rank: currentItem.rank }).eq("id", currentItem.id),
        supabaseClient.from(TABLE_NAME).update({ rank: targetItem.rank }).eq("id", targetItem.id),
      ]);
      const failedUpdate = updates.find((result) => result.error);

      if (failedUpdate) {
        currentItem.rank = currentRank;
        targetItem.rank = targetRank;
        items = sortItems(items);
        renderItems();
        throw failedUpdate.error;
      }
    } else {
      saveLocalItems();
    }

    setStatus(`Moved "${currentItem.name}" ${direction < 0 ? "up" : "down"}.`);
  });
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
    const url = row.querySelector("p");
    const upButton = row.querySelector(".move-up");
    const downButton = row.querySelector(".move-down");

    row.querySelector(".rank-number").textContent = index + 1;
    image.src = item.image_url;
    image.alt = item.name;
    image.loading = "lazy";
    title.textContent = item.name;
    url.textContent = formatImageUrl(item.image_url);

    upButton.disabled = index === 0 || isBusy;
    downButton.disabled = index === items.length - 1 || isBusy;
    upButton.addEventListener("click", () => moveItem(item.id, -1));
    downButton.addEventListener("click", () => moveItem(item.id, 1));

    rankingList.append(row);
  });
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

function formatImageUrl(imageUrl) {
  try {
    return new URL(imageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "Image";
  }
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
