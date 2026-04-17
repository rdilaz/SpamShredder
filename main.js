// --- HELPER FUNCTIONS ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const chunkArray = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

// --- QUOTA TRACKING LOGIC ---

const logQuota = async (cost) => {
  const now = Date.now();
  return new Promise((resolve) => {
    chrome.storage.local.get(['quotaHistory'], (data) => {
      let history = data.quotaHistory || [];
      history.push({ time: now, cost: cost });
      history = history.filter(item => now - item.time < 60000);
      chrome.storage.local.set({ quotaHistory: history }, resolve);
    });
  });
};

const getQuotaStats = async () => {
  const now = Date.now();
  return new Promise((resolve) => {
    chrome.storage.local.get(['quotaHistory'], (data) => {
      let history = data.quotaHistory || [];
      history = history.filter(item => now - item.time < 60000);
      const usedThisMinute = history.reduce((sum, item) => sum + item.cost, 0);
      const usedThisSecond = history.filter(item => now - item.time < 1000)
                                    .reduce((sum, item) => sum + item.cost, 0);
      resolve({ usedThisMinute, usedThisSecond });
    });
  });
};

// DRY Helper for Gmail API
const gmailApiFetch = async (url, token, retries = 3, backoff = 2000) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    }
  });

  if (response.status === 429 && retries > 0) {
    console.warn(`Rate limit hit! Retrying in ${backoff/1000}s...`);
    await sleep(backoff);
    return gmailApiFetch(url, token, retries - 1, backoff * 2); 
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, msg: ${errText}`);
  }
  
  await logQuota(5);
  return response.json();
};

const extractEmailAddress = (rawSender) => {
  if (!rawSender) return null;
  const emailMatch = rawSender.match(/<(.+?)>/);
  return (emailMatch && emailMatch[1] ? emailMatch[1] : rawSender).toLowerCase().trim();
};

const getManualUnsubLabel = (unsubData) => {
  if (unsubData?.https) return 'Open Unsub Page';
  if (unsubData?.mailto) return 'Open Mail App';
  return 'No Link';
};

const openManualUnsub = (unsubData) => {
  if (unsubData?.https) {
    window.open(unsubData.https, '_blank');
    return true;
  }

  if (unsubData?.mailto) {
    window.location.href = unsubData.mailto;
    return true;
  }

  return false;
};

const extractUnsubLink = (rawHeader) => {
  if (!rawHeader) return null;
  const httpsMatch = rawHeader.match(/<(https:\/\/[^>]+)>/);
  const mailtoMatch = rawHeader.match(/<(mailto:[^>]+)>/);
  return {
    https: httpsMatch ? httpsMatch[1] : null,
    mailto: mailtoMatch ? mailtoMatch[1] : null
  };
};

const getUnsubScore = (unsubData, requiresPost) => {
  if (unsubData?.https) return requiresPost ? 3 : 2;
  if (unsubData?.mailto) return 1;
  return 0;
};

const displayUserEmail = (token) => {
  const emailDisplay = document.getElementById('userEmailDisplay');
  fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(res => res.json())
  .then(data => {
    if (data.emailAddress) emailDisplay.innerText = data.emailAddress;
  })
  .catch(() => { emailDisplay.innerText = "Signed in"; });
};


// --- MAIN EXTENSION LOGIC ---

document.addEventListener('DOMContentLoaded', function() {
  const fetchButton = document.getElementById('fetchEmailsBtn');
  const scanLimitSelect = document.getElementById('scanLimitSelect');
  const clearStateBtn = document.getElementById('clearStateBtn');
  const resultsContainer = document.getElementById('resultsContainer');
  const progressContainer = document.getElementById('progressContainer');
  const statusLog = document.getElementById('statusLog');
  const progressBar = document.getElementById('progressBar');
  const quotaMinUi = document.getElementById('quotaMinUi');
  const quotaSecUi = document.getElementById('quotaSecUi');
  const signOutBtn = document.getElementById('signOutBtn');

  let currentLimit = 30; 

  // 1. STARTUP IDENTITY CHECK
  chrome.identity.getAuthToken({ interactive: false }, function(token) {
    if (chrome.runtime.lastError || !token) {
      document.getElementById('userEmailDisplay').innerText = "Signed out";
      signOutBtn.innerText = "Sign in"; 
    } else {
      displayUserEmail(token);
      signOutBtn.innerText = "Sign out"; 
    }
  });

  // 2. QUOTA UI UPDATER
  setInterval(async () => {
    const stats = await getQuotaStats();
    if (quotaMinUi && quotaSecUi) {
      quotaMinUi.innerText = stats.usedThisMinute;
      quotaSecUi.innerText = stats.usedThisSecond;
      quotaMinUi.style.color = stats.usedThisMinute > 12000 ? '#d93025' : '#5f6368';
    }
  }, 1000);

  // 3. RENDER FUNCTION
  const renderResults = (sendersList, totalUnique) => {
    resultsContainer.innerHTML = ''; 
    
    if (totalUnique !== undefined) {
      const headerText = document.createElement('p');
      headerText.innerText = `Showing top results from ${totalUnique} total unique senders.`;
      resultsContainer.appendChild(headerText);
    }

    // Use safe element creation instead of innerHTML += to prevent stripping events
    if (!sendersList || sendersList.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.style.textAlign = 'center';
      emptyMsg.style.padding = '20px';
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.style.fontSize = '14px';
      emptyMsg.innerText = "No promotional senders found with 4+ emails. Your inbox is squeaky clean!";
      resultsContainer.appendChild(emptyMsg);
      return;
    }

    const visibleSenders = sendersList.slice(0, currentLimit);
    
    visibleSenders.forEach((culprit) => {
      const email = culprit[0];
      const count = culprit[1].count;
      const exampleId = culprit[1].exampleId;

      const row = document.createElement('div');
      row.className = 'culprit-row';

      const info = document.createElement('div');
      info.className = 'culprit-info';
      info.innerHTML = `<strong>${count}</strong> emails from <br><span class="email-text">${email}</span><br>`;

      const exampleLink = document.createElement('a');
      exampleLink.className = 'example-link';
      exampleLink.href = `https://mail.google.com/mail/u/0/#all/${exampleId}`;
      exampleLink.target = '_blank';
      exampleLink.innerText = '🔍 View example email';
      info.appendChild(exampleLink);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'btn-group';

      // --- DELETE BUTTON ---
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'action-btn delete-btn';
      
      if (culprit[1].hasDeleted) {
        deleteBtn.innerText = 'Deleted!';
        deleteBtn.style.backgroundColor = '#0f9d58'; 
        deleteBtn.style.color = 'white';
        deleteBtn.disabled = true;
      } else {
        deleteBtn.innerText = 'Delete All';
        deleteBtn.addEventListener('click', () => {
          deleteBtn.innerText = "Searching...";
          deleteBtn.disabled = true;

          chrome.identity.getAuthToken({interactive: true}, async function(token) {
            if (chrome.runtime.lastError) {
               deleteBtn.innerText = "Auth Failed";
               return;
            }

            try {
              let allIds = [];
              let pageToken = '';
              let keepFetching = true;
              const encodedQuery = encodeURIComponent(`from:${email}`);
              let baseUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodedQuery}`;

              while (keepFetching) {
                let url = pageToken ? `${baseUrl}&pageToken=${pageToken}` : baseUrl;
                const data = await gmailApiFetch(url, token); 
                if (data.messages) {
                  allIds = allIds.concat(data.messages.map(msg => msg.id));
                  deleteBtn.innerText = `Found ${allIds.length}...`;
                }
                pageToken = data.nextPageToken;
                if (!pageToken) keepFetching = false;
              }

              if (allIds.length === 0) { 
                 deleteBtn.innerText = "None Found"; 
                 deleteBtn.disabled = false; // Added so it's not stuck
                 return; 
              }

              deleteBtn.innerText = "Trashing...";
              const batches = chunkArray(allIds, 1000);
              for (let i = 0; i < batches.length; i++) {
                const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/batchModify', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ids: batches[i], addLabelIds: ['TRASH'] })
                });
                if (!res.ok) throw new Error("Batch failed");
                if (i < batches.length - 1) await sleep(1000); 
              }

              culprit[1].hasDeleted = true;
              chrome.storage.local.set({ savedSenders: sendersList });

              deleteBtn.innerText = `Trashed ${allIds.length}!`;
              deleteBtn.style.backgroundColor = '#0f9d58'; 
              deleteBtn.style.color = 'white';

            } catch (error) {
              deleteBtn.innerText = "Error";
              deleteBtn.disabled = false;
            }
          });
        });
      }

      // --- UNSUBSCRIBE BUTTON ---
      const unsubBtn = document.createElement('button');
      unsubBtn.className = 'action-btn unsub-btn';
      
      if (culprit[1].hasUnsubscribed) {
        unsubBtn.innerText = "Unsubscribed!";
        unsubBtn.style.backgroundColor = '#0f9d58'; 
        unsubBtn.style.color = 'white';
        unsubBtn.disabled = true;
      } else if (!culprit[1].unsubData || (!culprit[1].unsubData.https && !culprit[1].unsubData.mailto)) {
        unsubBtn.disabled = true;
        unsubBtn.innerText = 'No Link';
      } else if (!culprit[1].unsubData.https && culprit[1].unsubData.mailto) {
        unsubBtn.innerText = 'Open Mail App';
        unsubBtn.onclick = () => {
          openManualUnsub(culprit[1].unsubData);
        };
      } else {
        unsubBtn.innerText = 'Unsubscribe';
        unsubBtn.onclick = async () => {
           const unsubData = culprit[1].unsubData;
           const requiresPost = culprit[1].requiresPost; 
           unsubBtn.innerText = "Attempting...";
           unsubBtn.disabled = true;

           let success = false;

           if (unsubData.https) {
             try {
               let response = await fetch(unsubData.https, {
                 method: requiresPost ? 'POST' : 'GET', 
                 headers: requiresPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
                 body: requiresPost ? 'List-Unsubscribe=One-Click' : null 
               });

               if (!response.ok && requiresPost) {
                 response = await fetch(unsubData.https, { method: 'GET' });
               }

               if (response.ok) {
                 const reply = await response.text(); 
                 if (!reply.toLowerCase().includes('<!doctype html>') && !reply.toLowerCase().includes('<html')) {
                    success = true;
                 }
               }
             } catch (err) { console.error(err); }
           }

           if (success) {
             culprit[1].hasUnsubscribed = true;
             chrome.storage.local.set({ savedSenders: sendersList });
             unsubBtn.innerText = "Unsubscribed!";
             unsubBtn.style.backgroundColor = '#0f9d58'; 
             unsubBtn.style.color = 'white';
           } else {
             unsubBtn.innerText = getManualUnsubLabel(unsubData);
             unsubBtn.style.backgroundColor = '#d93025';
             unsubBtn.style.color = 'white';
             unsubBtn.disabled = false;
              unsubBtn.onclick = () => {
                openManualUnsub(unsubData);
              };
            }
        };
      }

      btnGroup.appendChild(deleteBtn);
      btnGroup.appendChild(unsubBtn);
      row.appendChild(info);
      row.appendChild(btnGroup);
      resultsContainer.appendChild(row);
    });

    if (currentLimit < sendersList.length) {
      const moreBtn = document.createElement('button');
      moreBtn.innerText = `Show More (${sendersList.length - currentLimit} remaining)`;
      moreBtn.className = 'action-btn';
      moreBtn.style.width = '100%';
      moreBtn.style.marginTop = '10px';
      moreBtn.style.backgroundColor = '#e8eaed';
      moreBtn.style.color = '#3c4043';
      moreBtn.onclick = () => { currentLimit += 30; renderResults(sendersList, totalUnique); };
      resultsContainer.appendChild(moreBtn);
    }
  };

  // 4. STORAGE LOAD
  chrome.storage.local.get(['savedSenders', 'totalFound'], function(result) {
    if (result.savedSenders) {
      fetchButton.style.display = 'none';
      clearStateBtn.style.display = 'block';
      renderResults(result.savedSenders, result.totalFound || 'previous');
    }
  });

  // 5. SIGN OUT / SIGN IN LOGIC
  signOutBtn.addEventListener('click', (e) => {
    e.preventDefault();
    
    // If they are signed out, clicking should sign them IN
    if (signOutBtn.innerText === "Sign in") {
      signOutBtn.innerText = "Signing in...";
      
      chrome.identity.getAuthToken({ interactive: true }, function(token) {
        if (chrome.runtime.lastError || !token) {
          const errorMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "No token returned";
          console.error("Sign in failed:", errorMsg);
          
          progressContainer.style.display = 'flex';
          progressBar.style.display = 'none';
          statusLog.innerText = `Sign in error: ${errorMsg}`;
          
          signOutBtn.innerText = "Sign in"; 
          return;
        }
        
        displayUserEmail(token);
        signOutBtn.innerText = "Sign out";
        
        progressContainer.style.display = 'flex';
        progressBar.style.display = 'none';
        statusLog.innerText = "Signed in successfully! Ready to fetch.";
      });
      return; 
    }

    // Existing Sign Out Logic
    signOutBtn.innerText = "Signing out...";
    chrome.identity.getAuthToken({ interactive: false }, function(token) {
      if (chrome.runtime.lastError || !token) { resetUi(); return; }
      fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
        .then(() => chrome.identity.removeCachedAuthToken({ token }, () => resetUi()));
    });
  });

  const resetUi = () => {
    chrome.storage.local.remove(['savedSenders', 'totalFound'], () => {
      resultsContainer.innerHTML = '';
      clearStateBtn.style.display = 'none';
      fetchButton.style.display = 'block';
      fetchButton.innerText = 'Fetch Recent Emails';
      fetchButton.disabled = false; // Reset button lock
      
      signOutBtn.innerText = "Sign in"; 
      document.getElementById('userEmailDisplay').innerText = "Signed out";
      if (statusLog) statusLog.innerText = "Signed out.";
    });
  };

  // 6. CLEAR STATE
  clearStateBtn.addEventListener('click', () => {
    chrome.storage.local.remove(['savedSenders', 'totalFound'], () => {
      resultsContainer.innerHTML = '';
      clearStateBtn.style.display = 'none';
      fetchButton.style.display = 'block';
      fetchButton.innerText = 'Fetch Recent Emails'; // Ensure text is correct
    });
  });

  // 7. FETCH LOGIC
  fetchButton.addEventListener('click', function() {
    chrome.identity.getAuthToken({interactive: true}, async function(token) {
      if(chrome.runtime.lastError) {
        statusLog.innerText = "Auth Error: " + chrome.runtime.lastError.message;
        return;
      }
      
      displayUserEmail(token);
      fetchButton.innerText = "Working...";
      fetchButton.disabled = true;
      progressContainer.style.display = 'flex';
      progressBar.style.display = 'block'; // Make sure it's visible again!
      statusLog.innerText = "Fetching messages...";
      
      const scanLimit = parseInt(scanLimitSelect.value, 10);
      try {
        let allMessages = [];
        let pageToken = '';
        let keepFetching = true;
        const query = encodeURIComponent("category:promotions -from:me -from:*@akamai.com -from:*@boston.umb.edu");
        let baseUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${query}`;
        
        while (keepFetching && allMessages.length < scanLimit) {
          let url = pageToken ? `${baseUrl}&pageToken=${pageToken}` : baseUrl;
          const data = await gmailApiFetch(url, token);
          if (data.messages) allMessages = allMessages.concat(data.messages);
          pageToken = data.nextPageToken;
          if (!pageToken) keepFetching = false;
        }
        
        // Ensure we don't scan drastically more than the dropdown asked for
        allMessages = allMessages.slice(0, scanLimit);
        
        const senderCounts = {};
        const batches = chunkArray(allMessages, 20);
        progressBar.max = batches.length;
        
        for (let i = 0; i < batches.length; i++) {
          statusLog.innerText = `Analyzing batch ${i + 1} of ${batches.length}...`;
          progressBar.value = i + 1;
          const batchResults = await Promise.all(batches[i].map(async (msg) => {
            try {
              const url = `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`;
              const data = await gmailApiFetch(url, token);
              
              // Safe access: sometimes payloads are oddly formatted or missing entirely
              const headers = data.payload?.headers || [];
              return { 
                email: extractEmailAddress(headers.find(h => h.name === 'From')?.value),
                unsub: extractUnsubLink(headers.find(h => h.name === 'List-Unsubscribe')?.value),
                post: headers.find(h => h.name === 'List-Unsubscribe-Post')?.value,
                id: msg.id 
              };
            } catch(e) { 
              console.error(`Failed reading message ${msg.id}:`, e);
              return null; 
            }
          }));

          batchResults.forEach(res => {
            if (res && res.email) {
              if (!senderCounts[res.email]) {
                senderCounts[res.email] = { count: 0, exampleId: res.id, unsubData: res.unsub, requiresPost: res.post };
              }

              const existing = senderCounts[res.email];
              if (getUnsubScore(res.unsub, res.post) > getUnsubScore(existing.unsubData, existing.requiresPost)) {
                existing.unsubData = res.unsub;
                existing.requiresPost = res.post;
                existing.exampleId = res.id;
              }

              senderCounts[res.email].count++;
            }
          });
          if (i < batches.length - 1) await sleep(300); 
        }
        
        const sorted = Object.entries(senderCounts).sort((a, b) => b[1].count - a[1].count).filter(s => s[1].count >= 4);
        chrome.storage.local.set({ savedSenders: sorted, totalFound: Object.keys(senderCounts).length });
        
        progressContainer.style.display = 'none';
        fetchButton.style.display = 'none';
        clearStateBtn.style.display = 'block';
        currentLimit = 30;
        renderResults(sorted, Object.keys(senderCounts).length);

      } catch(err) { 
        statusLog.innerText = `Error: ${err.message}`; 
        console.error("Fetch Process Error:", err);
        fetchButton.innerText = "Fetch Recent Emails"; // Don't leave it stuck on "Working..."
      } finally { 
        fetchButton.disabled = false; 
      }
    });
  });
});
