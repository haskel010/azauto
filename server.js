import { ClientSecretCredential } from "@azure/identity";
import { StorageManagementClient } from "@azure/arm-storage";
import { BlobServiceClient } from "@azure/storage-blob";
import fs from "fs";
import path from "path";
import { lookup as getMimeType } from "mime-types";
import { supabase } from "./utils/supabaseClient.js";
import {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  AZURE_SUBSCRIPTION_ID,
  AZURE_RESOURCE_GROUP,
  LINKTABLE,
} from "./keys.js";



// ===== CONFIG =====
const subscriptionId = AZURE_SUBSCRIPTION_ID;
const resourceGroupName = AZURE_RESOURCE_GROUP;
const location = "eastus";
const DEPLOY_INTERVAL_MS = 1 * 60 * 1000; // 2 minutes

// ===== AUTH =====
const credential = new ClientSecretCredential(
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET
);

// ===== STEP 1: CREATE STORAGE ACCOUNT =====
async function createStorageAccount(accountName, storageClient) {
  console.log("Creating storage account:", accountName);

  await storageClient.storageAccounts.beginCreateAndWait(
    resourceGroupName,
    accountName,
    {
      location,
      sku: { name: "Standard_LRS" },
      kind: "StorageV2",
    }
  );

  console.log("Created ✅");
}

// ===== STEP 3: GET CONNECTION STRING =====
async function getConnectionString(accountName, storageClient) {
  const keys = await storageClient.storageAccounts.listKeys(
    resourceGroupName,
    accountName
  );

  const key = keys.keys[0].value;

  return `DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${key};EndpointSuffix=core.windows.net`;
}

// ===== STEP 4: ENABLE STATIC WEBSITE (data plane) =====
// Uses BlobServiceClient directly — this is what the portal uses and
// reliably creates the $web container + enables the feature.
async function enableStaticWebsite(connectionString) {
  console.log("Enabling static website...");

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

  await blobServiceClient.setProperties({
    staticWebsite: {
      enabled: true,
      indexDocument: "index.html",
      errorDocument404Path: "404.html",
    },
  });

  console.log("Static website enabled ✅");
}

// ===== STEP 5: UPLOAD FILES =====
async function uploadFiles(connectionString, folderPath) {
  const blobServiceClient =
    BlobServiceClient.fromConnectionString(connectionString);

  const containerClient = blobServiceClient.getContainerClient("$web");

  async function uploadDir(dir) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);

      if (fs.lstatSync(fullPath).isDirectory()) {
        await uploadDir(fullPath);
      } else {
        const blobName = path.relative(folderPath, fullPath);

        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const contentType = getMimeType(fullPath) || "application/octet-stream";

        await blockBlobClient.uploadFile(fullPath, {
          blobHTTPHeaders: { blobContentType: contentType },
        });

        console.log("Uploaded:", blobName);
      }
    }
  }

  await uploadDir(folderPath);
}

// ===== ENABLED CHECK =====
async function isEnabled() {
  const { data, error } = await supabase
    .from('popups')
    .select('is_enabled')
    .eq('link_table', LINKTABLE)
    .single();

  if (error) {
    console.error('[deploy] Failed to check enabled status:', error.message);
    return false;
  }

  return data?.is_enabled === true;
}

// ===== MAIN DEPLOY =====
async function deploy() {
  if (!(await isEnabled())) {
    console.log('[deploy] Service is disabled. Skipping.');
    return;
  }

  // Fresh unique account name and client per run
  const accountName = 'site' + Date.now();
  const storageClient = new StorageManagementClient(credential, subscriptionId);
  const buildPath = './dist';

  try {
    await createStorageAccount(accountName, storageClient);

    const connectionString = await getConnectionString(accountName, storageClient);

    await enableStaticWebsite(connectionString);

    await uploadFiles(connectionString, buildPath);

    const liveUrl = `https://${accountName}.z13.web.core.windows.net/index.html`;

    console.log('LIVE:', liveUrl);

    // ===== PUSH TO SUPABASE =====
    const { error } = await supabase
      .from('windows2')
      .insert({ link: liveUrl, status: 'healthy' });

    if (error) {
      console.error('Supabase insert failed:', error.message);
    } else {
      console.log('Link saved to Supabase:', liveUrl);
    }
  } catch (err) {
    console.error('Deploy failed:', err.message);
  }
}

// ===== RUN IMMEDIATELY, THEN EVERY 3 MINUTES =====
console.log('Starting deploy loop (every 180s)...');
deploy();
setInterval(deploy, DEPLOY_INTERVAL_MS);
