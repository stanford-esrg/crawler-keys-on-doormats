const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Convert all SQLite databases from source to destination and clean up
 * Usage: node db_to_json.js <date>
 * Example: node db_to_json.js 10-15-2025
 */

// Helper function to ensure directory exists
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Helper function to remove empty directories recursively
function removeEmptyDirectories(dirPath) {
  try {
    execSync(`find ${dirPath} -type d -empty -delete`, { stdio: 'inherit' });
    return true;
  } catch (error) {
    console.error(`Error removing empty directories in ${dirPath}:`, error.message);
    return false;
  }
}

// Helper function to extract container number from filename
function extractContainerNumber(filename) {
  // Try to extract container number from filename patterns like:
  // container-1.log, crawl-container-2.log, etc.
  const match = filename.match(/(?:container|crawl-container)-?(\d+)/i);
  return match ? match[1] : 'unknown';
}

// Helper function to combine log files into a single file
function combineLogFiles(sourceLogsDir, destLogFile) {
  try {
    if (!fs.existsSync(sourceLogsDir)) {
      console.log(`  No logs directory found at: ${sourceLogsDir}`);
      return false;
    }

    const logFiles = fs.readdirSync(sourceLogsDir).filter(file => 
      file.endsWith('.log') || file.endsWith('.txt')
    );

    if (logFiles.length === 0) {
      console.log(`  No log files found in: ${sourceLogsDir}`);
      return false;
    }

    console.log(`  Found ${logFiles.length} log file(s) to combine`);

    let combinedContent = '';
    
    for (const logFile of logFiles) {
      const containerNumber = extractContainerNumber(logFile);
      const logFilePath = path.join(sourceLogsDir, logFile);
      
      try {
        const content = fs.readFileSync(logFilePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        // Add header for this container's logs
        combinedContent += `\n=== Container ${containerNumber} (${logFile}) ===\n`;
        
        // Add each line with container prefix
        lines.forEach(line => {
          combinedContent += `[Container ${containerNumber}] ${line}\n`;
        });
        
        console.log(`    ✓ Processed ${logFile} (Container ${containerNumber})`);
      } catch (error) {
        console.error(`    ✗ Error reading ${logFile}:`, error.message);
        combinedContent += `\n=== Container ${containerNumber} (${logFile}) ===\n`;
        combinedContent += `[Container ${containerNumber}] ERROR: Could not read file - ${error.message}\n`;
      }
    }

    // Write combined log file
    fs.writeFileSync(destLogFile, combinedContent);
    console.log(`  ✓ Combined logs saved to: ${destLogFile}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error combining log files:`, error.message);
    return false;
  }
}

function convertDbToJson(dbPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dbPath)) {
      reject(new Error(`Database file not found: ${dbPath}`));
      return;
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }
    });

    const result = {
      metadata: {
        source_db: path.basename(dbPath),
        converted_at: new Date().toISOString(),
        website: path.basename(dbPath, '.db')
      },
      data: {}
    };

    const tables = ['requests', 'responses'];
    let completed = 0;

    tables.forEach(tableName => {
      db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
        if (err) {
          console.error(`  Error reading ${tableName}:`, err.message);
          result.data[tableName] = [];
        } else {
          result.data[tableName] = rows;
        }

        completed++;
        if (completed === tables.length) {
          db.close();
          resolve(result);
        }
      });
    });
  });
}

// Helper function to delete a file
function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error.message);
    return false;
  }
}

// Helper function to delete SQLite database and its auxiliary files
function deleteSqliteDb(dbPath) {
  let deleted = 0;
  const filesToDelete = [dbPath, dbPath + '-shm', dbPath + '-wal'];
  
  filesToDelete.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      if (deleteFile(filePath)) {
        deleted++;
      }
    }
  });
  
  return deleted > 0;
}

async function main() {
  if (process.argv.length < 3) {
    console.error('Usage: node db_to_json.js <date>');
    console.error('Example: node db_to_json.js 10-15-2025');
    process.exit(1);
  }

  const date = process.argv[2];
  
  // Define source and destination paths
  const sourceBaseDir = '/home/XXXX-4/crawler/output';
  const destBaseDir = '/mnt/web-secrets/XXXX-4/output';
  
  const sourceDateDir = path.join(sourceBaseDir, date);
  const destDateDir = path.join(destBaseDir, date);
  
  const sourceDbDir = path.join(sourceDateDir, 'DB');
  const destJsonDir = path.join(destDateDir, 'JSON');
  const sourceLogsDir = path.join(sourceDateDir, 'logs');
  const destLogsDir = path.join(destDateDir, 'logs');
  const destCombinedLogFile = path.join(destLogsDir, 'docker-crawl-logs.log');
  
  const logFile = path.join(destLogsDir, 'json-conversion-logs.log');

  // Check if source date directory exists
  if (!fs.existsSync(sourceDateDir)) {
    console.error(`Error: Source directory not found: ${sourceDateDir}`);
    process.exit(1);
  }

  // Check if source DB directory exists
  if (!fs.existsSync(sourceDbDir)) {
    console.error(`Error: Source DB directory not found: ${sourceDbDir}`);
    process.exit(1);
  }

  // Ensure destination directories exist
  ensureDirectoryExists(destJsonDir);

  console.log(`Processing date: ${date}`);
  console.log(`Source: ${sourceDateDir}`);
  console.log(`Destination: ${destDateDir}`);
  console.log('='.repeat(80));

  let totalSuccessCount = 0;
  let totalFailCount = 0;
  const failedFiles = [];

  // Process .db files in two iterations
  for (let iteration = 1; iteration <= 2; iteration++) {
    const dbFiles = fs.readdirSync(sourceDbDir).filter(file => file.endsWith('.db'));
    
    if (dbFiles.length === 0) {
      console.log(`\n✓ All .db files processed. Source DB directory is now empty.`);
      break;
    }

    console.log(`\n--- Iteration ${iteration} ---`);
    console.log(`Found ${dbFiles.length} database file(s) to process`);

    let iterationSuccessCount = 0;
    let iterationFailCount = 0;

    for (const dbFile of dbFiles) {
      const sourceDbPath = path.join(sourceDbDir, dbFile);
      const jsonFileName = path.basename(dbFile, '.db') + '.json';
      const jsonPath = path.join(destJsonDir, jsonFileName);

      console.log(`\nProcessing: ${dbFile}`);

      // Convert .db file to JSON
      console.log(`  Converting ${dbFile} to JSON...`);
      try {
        const jsonData = await convertDbToJson(sourceDbPath);
        fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
        
        console.log(`  ✓ Successfully converted to: ${jsonFileName}`);
        console.log(`    - Requests: ${jsonData.data.requests.length}`);
        console.log(`    - Responses: ${jsonData.data.responses.length}`);
        
        // Delete .db file and SQLite auxiliary files only if conversion succeeded
        if (deleteSqliteDb(sourceDbPath)) {
          console.log(`  ✓ Deleted ${dbFile} and auxiliary files`);
        }
        
        iterationSuccessCount++;
      } catch (error) {
        console.error(`  ✗ Failed to convert ${dbFile}:`, error.message);
        failedFiles.push({ 
          file: dbFile, 
          error: error.message, 
          iteration: iteration,
          timestamp: new Date().toISOString()
        });
        iterationFailCount++;
      }
    }

    totalSuccessCount += iterationSuccessCount;
    totalFailCount += iterationFailCount;
    
    console.log(`\nIteration ${iteration} complete:`);
    console.log(`  Success: ${iterationSuccessCount}`);
    console.log(`  Failed: ${iterationFailCount}`);
    
    // After first iteration, pause before retry
    if (iteration === 1 && dbFiles.length > 0 && iterationFailCount > 0) {
      console.log(`\nSecond iteration will retry the failed conversions...`);
    }
  }

  // Step 3: Log failed conversions
  if (failedFiles.length > 0) {
    console.log(`\nLogging ${failedFiles.length} failed conversions...`);
    const logContent = failedFiles.map(f => 
      `[${f.timestamp || new Date().toISOString()}] [Iteration ${f.iteration || '?'}] ${f.file}: ${f.error}`
    ).join('\n');
    
    ensureDirectoryExists(destLogsDir);
    fs.writeFileSync(logFile, logContent);
    console.log(`✓ Error log saved to: ${logFile}`);
  }

  // Step 4: Combine and move logs
  console.log(`\nProcessing logs directory...`);
  if (fs.existsSync(sourceLogsDir)) {
    // Ensure destination logs directory exists
    ensureDirectoryExists(destLogsDir);
    
    // Combine all log files into a single docker-crawl-logs.log
    if (combineLogFiles(sourceLogsDir, destCombinedLogFile)) {
      console.log(`✓ Logs combined and saved to: ${destCombinedLogFile}`);
    } else {
      console.log(`⚠ No logs were combined`);
    }
  } else {
    console.log(`\nNo logs directory found at: ${sourceLogsDir}`);
  }

  // Step 5: Clean up remaining SQLite auxiliary files (.db-shm and .db-wal)
  console.log(`\nCleaning up SQLite auxiliary files...`);
  let shmFiles = fs.readdirSync(sourceDbDir).filter(file => file.endsWith('-shm'));
  let walFiles = fs.readdirSync(sourceDbDir).filter(file => file.endsWith('-wal'));
  
  let deletedAux = 0;
  shmFiles.forEach(file => {
    if (deleteFile(path.join(sourceDbDir, file))) {
      deletedAux++;
    }
  });
  walFiles.forEach(file => {
    if (deleteFile(path.join(sourceDbDir, file))) {
      deletedAux++;
    }
  });
  
  console.log(`✓ Deleted ${deletedAux} SQLite auxiliary files (-shm and -wal)`);

  // Step 6: Clean up empty directories
  console.log(`\nCleaning up empty directories...`);
  removeEmptyDirectories(sourceDateDir);
  console.log(`✓ Empty directories removed`);

  // Final summary
  console.log('\n' + '='.repeat(80));
  console.log(`\nProcessing complete!`);
  console.log(`  Total Success: ${totalSuccessCount}`);
  console.log(`  Total Failed: ${totalFailCount}`);
  console.log(`  Failed Files Logged: ${failedFiles.length}`);
  console.log(`\nDestination: ${destDateDir}`);
}

main();

