class Node {
    static ofElement(e) {
        const tags = {};
        for (const t of e.getElementsByTagName("tag"))
            tags[t.getAttribute("k")] = t.getAttribute("v");

        return new Node(e.getAttribute("id"), e.getAttribute("version"), e.getAttribute("visible") === "false", e.getAttribute("lat"), e.getAttribute("lon"), tags);
    }

    static ofLastRealId(osmId) {
        const nodeHistory = fetchXml("https://api.openstreetmap.org/api/0.6/node/" + osmId + "/history").getElementsByTagName("node");
        for (let i = nodeHistory.length - 1; i >= 0; i--) {
            if (nodeHistory._nodes[i].hasAttribute("lat") && nodeHistory._nodes[i].hasAttribute("lon")) {
                return Node.ofElement(nodeHistory._nodes[i]);
            }
        }
    }

    constructor(osmId, version, deleted, lat, lon, tags) {
        this.osmId = osmId;
        this.version = version;
        this.deleted = deleted;
        this.lat = lat;
        this.lon = lon;
        this.tags = tags;
    }

    prevVersion() {
        return Node.ofElement(fetchXml("https://api.openstreetmap.org/api/0.6/node/" + this.osmId + "/" + (this.version - 1)).getElementsByTagName("node")._nodes[0]);
    }
}

class Way {
    static ofElement(e) {
        const nodes = [];
        for (const nd of e.getElementsByTagName("nd"))
            nodes.push(nd.getAttribute("ref"));

        const tags = {};
        for (const t of e.getElementsByTagName("tag"))
            tags[t.getAttribute("k")] = t.getAttribute("v");

        return new Way(e.getAttribute("id"), e.getAttribute("version"), e.getAttribute("visible") === "false", nodes, tags);
    }

    constructor(osmId, version, deleted, nodes, tags) {
        this.osmId = osmId;
        this.version = version;
        this.deleted = deleted;
        this.nodes = nodes;
        this.tags = tags;
    }

    prevVersion() {
        return Way.ofElement(fetchXml("https://api.openstreetmap.org/api/0.6/way/" + this.osmId + "/" + (this.version - 1)).getElementsByTagName("way")._nodes[0]);
    }
}

// Main Code
// Parameters: [ id ]
onmessage = e => {
    importScripts("./xmlsax.js", "./xmlw3cdom.js");

    // Process Metadata
    const id = e.data[0];
    const meta = fetchXml("https://api.openstreetmap.org/api/0.6/changeset/" + id);

    let tagString = "<h3>Tags</h3>";
    for (const t of meta.getElementsByTagName("tag")) {
        tagString += `<p><b>${t.getAttribute("k")}</b> ${t.getAttribute("v")}</p>`;
    }

    const changeElement = meta.getElementsByTagName("changeset")._nodes[0];
    const metaString = `
        <h2>Changeset ${id}</h2>
        <p><b>Author</b> ${changeElement.getAttribute("user")}</p>
        <p><b>Started</b> ${changeElement.getAttribute("created_at")}</p>
        <p><b>Submitted</b> ${changeElement.getAttribute("closed_at")}</p>
        <p><b>Changes</b> ${changeElement.getAttribute("changes_count")}</p>
        ${tagString}
        <div class='hr'></div>
        <h3 id='loading-text'>Loading nodes... [0/?]</h3>`;
    postMessage([ "ADD", metaString ]);

    // Process Actual change data
    const data = fetchXml("https://api.openstreetmap.org/api/0.6/changeset/" + id + "/download");

    // Count requests we need to make
    let requestCount = 0;
    let requestTotal = 0;
    for (const e of data.getElementsByTagName("node")) {
        if (e.parentNode.tagName === "modify" || e.parentNode.tagName === "delete")
            requestTotal++;
    }
    postMessage([ "ADD", `<h3 id='loading-text'>Loading nodes... [${requestCount}/${requestTotal}]</h3>` ]);

    // id -> cached node
    const nodePool = {};
    const created = [];
    const modified = [];
    const deleted = [];
    let changedTagsString = "<h3>Changed Tags</h3>";
    for (const e of data.getElementsByTagName("node")) {
        const node = Node.ofElement(e);
        if (e.parentNode.tagName === "create") {
            created.push(node);
            nodePool[node.osmId] = node;
        } else if (e.parentNode.tagName === "modify") {
            modified.push(node);
            nodePool[node.osmId] = node;

            const oldNode = node.prevVersion();
            changedTagsString += getDiffTable(`Node ${node.osmId} (v${node.version - 1} -> v${node.version})`, oldNode.tags, node.tags);

            requestCount++;
            postMessage([ "ADD", `<h3 id='loading-text'>Loading nodes... [${requestCount}/${requestTotal}]</h3>` ]);
        } else if (e.parentNode.tagName === "delete") {
            const prevNode = node.prevVersion();
            deleted.push(prevNode);
            nodePool[node.osmId] = prevNode;

            requestCount++;
            postMessage([ "ADD", `<h3 id='loading-text'>Loading nodes... [${requestCount}/${requestTotal}]</h3>` ]);
        } else {
            console.log("Uh Node? " + e.parentNode);
        }
    }

    // Count way requests
    requestCount = 0;
    requestTotal = 0;
    const requestSet = new Set();
    for (const e of data.getElementsByTagName("way")) {
        for (const nd of e.getElementsByTagName("nd")) {
            if (!nodePool[nd.getAttribute("ref")])
                requestSet.add(nd.getAttribute("ref"));
        }

        if (e.parentNode.tagName === "modify" || e.parentNode.tagName === "delete")
            requestTotal++;
    }
    requestTotal += requestSet.size;
    postMessage([ "ADD", `<h3 id='loading-text'>Loading ways... [${requestCount}/${requestTotal}]</h3>` ]);

    const createdWays = [];
    const modifiedWays = [];
    const deletedWays = [];
    for (const e of data.getElementsByTagName("way")) {
        const way = Way.ofElement(e);
        const wayList = [];

        for (const nodeId of way.nodes) {
            if (!nodePool[nodeId]) {
                nodePool[nodeId] = Node.ofLastRealId(nodeId);
                requestCount++;
                postMessage([ "ADD", `<h3 id='loading-text'>Loading ways... [${requestCount}/${requestTotal}]</h3>` ]);
            }

            wayList.push(nodePool[nodeId]);
        }

        if (e.parentNode.tagName === "create") {
            createdWays.push(wayList);
        } else if (e.parentNode.tagName === "modify") {
            modifiedWays.push(wayList);

            const oldWay = way.prevVersion();
            changedTagsString += getDiffTable(`Way ${way.osmId} (v${way.version - 1} -> v${way.version})`, oldWay.tags, way.tags);
            requestCount++;
            postMessage([ "ADD", `<h3 id='loading-text'>Loading ways... [${requestCount}/${requestTotal}]</h3>` ]);
        } else if (e.parentNode.tagName === "delete") {
            for (const oldNodeId of way.prevVersion().nodes) {
                if (!nodePool[oldNodeId]) {
                    nodePool[oldNodeId] = Node.ofLastRealId(oldNodeId);
                }

                wayList.push(nodePool[oldNodeId]);
            }

            deletedWays.push(wayList);
            requestCount++;
            postMessage([ "ADD", `<h3 id='loading-text'>Loading ways... [${requestCount}/${requestTotal}]</h3>` ]);
        } else {
            console.log("Uh Way? " + e.parentNode);
        }
    }

    changedTagsString += "<div class='hr'></div><h3 id='loading-text'>Loading map...</h3>"
    postMessage([ "ADD", changedTagsString ]);
    postMessage([ "ADD_MAP", created, modified, deleted, createdWays, modifiedWays, deletedWays ]);
}

function fetchXml(url) {
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.send();
    return new DOMImplementation().loadXML(request.responseText).getDocumentElement();
}

function getDiffTable(title, oldTags, newTags) {
    let tableString = "";
    let changed = 0;
    for (const oldTag in oldTags) {
        if (!newTags[oldTag]) {
            tableString = tableString + `<tr><th>${oldTag}</th><td class="old-tag">${oldTags[oldTag]}</td><td class="new-tag"></td></tr>`;
            changed++;
        } else if (newTags[oldTag] !== oldTags[oldTag]) {
            tableString = tableString + `<tr><th>${oldTag}</th><td class="old-tag">${oldTags[oldTag]}</td><td class="new-tag">${newTags[oldTag]}</td></tr>`;
            changed++;
        } else {
            tableString = tableString + `<tr><th>${oldTag}</th><td class="unchanged-tag">${oldTags[oldTag]}</td><td class="unchanged-tag">${newTags[oldTag]}</td></tr>`;
        }
    }

    for (const newTag in newTags) {
        if (!oldTags[newTag]) {
            tableString = tableString + `<tr><th>${newTag}</th><td class="old-tag"></td><td class="new-tag">${newTags[newTag]}</td></tr>`;
            changed++;
        }
    }

    return changed === 0 ? "" : `
            <details>
                <summary>${title}</summary>
                <table><tbody>${tableString}</tbody></table>
            </details>`;
}