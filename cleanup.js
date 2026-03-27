import { ClientSecretCredential } from "@azure/identity";
import { StorageManagementClient } from "@azure/arm-storage";
import { supabase } from "./utils/supabaseClient.js";
import {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  AZURE_SUBSCRIPTION_ID,
  AZURE_RESOURCE_GROUP,
  LINKTABLE,
} from "./keys.js";

const subscriptionId = AZURE_SUBSCRIPTION_ID;
const resourceGroupName = AZURE_RESOURCE_GROUP;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

const credential = new ClientSecretCredential(
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET
);

// Extract storage account name from the static website URL
function extractAccountName(link) {
  try {
    const hostname = new URL(link).hostname; // e.g. site1234567890.z13.web.core.windows.net
    return hostname.split(".")[0];
  } catch {
    return null;
  }
}

async function deleteStorageAccount(accountName, storageClient) {
  console.log(`[cleanup] Deleting storage account: ${accountName}`);
  await storageClient.storageAccounts.delete(resourceGroupName, accountName);
  console.log(`[cleanup] Deleted storage account: ${accountName} ✅`);
}

async function isEnabled() {
  const { data, error } = await supabase
    .from('popups')
    .select('is_enabled')
    .eq('link_table', LINKTABLE)
    .single();

  if (error) {
    console.error('[cleanup] Failed to check enabled status:', error.message);
    return false;
  }

  return data?.is_enabled === true;
}

async function cleanup() {
 

  const oneHourAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("windows2")
    .select("id, link, created_at")
    .lte("created_at", oneHourAgo);

  if (error) {
    console.error("[cleanup] Supabase query failed:", error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log("[cleanup] No expired rows found.");
    return;
  }

  console.log(`[cleanup] Found ${rows.length} expired row(s). Cleaning up...`);

  const storageClient = new StorageManagementClient(credential, subscriptionId);

  for (const row of rows) {
    const accountName = extractAccountName(row.link);

    if (!accountName) {
      console.warn(`[cleanup] Could not parse account name from link: ${row.link}`);
    } else {
      try {
        await deleteStorageAccount(accountName, storageClient);
      } catch (err) {
        console.error(`[cleanup] Failed to delete storage account ${accountName}:`, err.message);
      }
    }

    // Delete the Supabase row regardless of whether storage deletion succeeded
    const { error: deleteError } = await supabase
      .from("windows2")
      .delete()
      .eq("id", row.id);

    if (deleteError) {
      console.error(`[cleanup] Failed to delete Supabase row ${row.id}:`, deleteError.message);
    } else {
      console.log(`[cleanup] Deleted Supabase row ${row.id} ✅`);
    }
  }
}

// ===== RUN IMMEDIATELY, THEN EVERY 5 MINUTES =====
console.log("[cleanup] Starting cleanup loop (every 5 min)...");
cleanup();
setInterval(cleanup, CLEANUP_INTERVAL_MS);
