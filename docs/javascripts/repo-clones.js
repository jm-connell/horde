(() => {
  const scriptUrl = document.currentScript && document.currentScript.src;

  function formatFact(n) {
    if (n > 999) {
      const decimals = Number((n - 950) % 1000 > 99);
      return `${((n + 1e-6) / 1000).toFixed(decimals)}k`;
    }
    return String(n);
  }

  function addCloneFact(facts, count) {
    if (facts.querySelector(".md-source__fact--clones")) {
      return;
    }
    const item = document.createElement("li");
    item.className = "md-source__fact md-source__fact--clones";
    item.textContent = formatFact(count);
    item.title = `${count} clone${count === 1 ? "" : "s"}`;
    facts.appendChild(item);
  }

  function inject(count) {
    const lists = document.querySelectorAll(".md-source__facts");
    lists.forEach((facts) => addCloneFact(facts, count));
    return (
      lists.length > 0 &&
      Array.from(lists).every((facts) => facts.querySelector(".md-source__fact--clones"))
    );
  }

  function watch(count) {
    if (inject(count)) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (inject(count)) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function loadCount() {
    const urls = [];
    if (scriptUrl) {
      urls.push(new URL("../assets/github-clones.json", scriptUrl).href);
    }
    const repoHref = document.querySelector("a.md-source")?.href;
    const match = repoHref && repoHref.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (match) {
      const repo = match[1].replace(/\.git$/, "");
      urls.push(`https://raw.githubusercontent.com/${repo}/main/docs/assets/github-clones.json`);
    }
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        if (data && typeof data.count === "number") {
          return data.count;
        }
      } catch {
        /* try the next URL */
      }
    }
    return null;
  }

  loadCount().then((count) => {
    if (count == null) {
      return;
    }
    watch(count);
  });
})();
