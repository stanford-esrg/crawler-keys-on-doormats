#!/bin/bash

# Configuration
TOTAL_CONTAINERS=20
CONTAINER_PREFIX="crawler"
IMAGE_NAME="leakyweb-crawler"
OUTPUT_DIR="output"
CSV_FILE="leaky-sites.csv"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to get the most recent date directory
get_latest_date_dir() {
    if [ -d "$OUTPUT_DIR" ]; then
        ls -td "$OUTPUT_DIR"/*/ 2>/dev/null | head -1 | sed 's|/$||'
    else
        print_error "Output directory not found: $OUTPUT_DIR"
        exit 1
    fi
}

# Function to parse logs and find failed websites
parse_failed_websites() {
    local date_dir=$1
    local logs_dir="$date_dir/logs"
    
    if [ ! -d "$logs_dir" ]; then
        print_error "Logs directory not found: $logs_dir"
        exit 1
    fi
    
    print_status "Parsing failure logs in $logs_dir..." >&2
    
    python3 << PYTHON_EOF
import os
import re
import sys
from pathlib import Path

logs_dir = "$logs_dir"
failed_websites = set()

# Find all failure log files
log_files = []
for file in os.listdir(logs_dir):
    if file.startswith('crawler-failures-container-') and file.endswith('.log'):
        log_files.append(os.path.join(logs_dir, file))

print(f'Found {len(log_files)} failure log files', file=sys.stderr)

# Parse each log file
for log_file in log_files:
    try:
        with open(log_file, 'r') as f:
            for line in f:
                # Extract URL from log line
                # Format: TIMESTAMP | URL | Attempt N | Timeout Xms | Error: ...
                match = re.search(r'\|\s*(https?://[^\s\|]+)\s*\|', line)
                if match:
                    url = match.group(1)
                    failed_websites.add(url)
    except Exception as e:
        print(f'Error reading {log_file}: {e}', file=sys.stderr)

# Output failed websites as comma-separated
if failed_websites:
    print(','.join(sorted(failed_websites)))
else:
    print('')
PYTHON_EOF
}

# Function to find completed websites from DB files
parse_completed_websites() {
    local date_dir=$1
    local db_dir="$date_dir/DB"
    
    if [ ! -d "$db_dir" ]; then
        print_error "DB directory not found: $db_dir"
        exit 1
    fi
    
    print_status "Finding completed websites from DB files in $db_dir..." >&2
    
    python3 << PYTHON_EOF
import os
import sys
from urllib.parse import urlparse

db_dir = "$db_dir"
completed_websites = set()

# Find all .db files
for filename in os.listdir(db_dir):
    if filename.endswith('.db'):
        # Extract website from filename (format: website.com_.db)
        website = filename.replace('_', '').replace('.db', '')
        completed_websites.add(website)

# Output completed websites as comma-separated
if completed_websites:
    print(','.join(sorted(completed_websites)))
else:
    print('')
PYTHON_EOF
}

# Function to calculate websites to retry
calculate_retry_list() {
    local date_dir=$1
    local failed_list=$2
    local completed_list=$3
    
    print_status "Calculating websites that need to be retried..." >&2
    
    python3 << PYTHON_EOF
import csv
import sys
from urllib.parse import urlparse

csv_file = "$CSV_FILE"
failed_list_str = "$failed_list"
completed_list_str = "$completed_list"

# Parse failed and completed lists
failed_websites = set()
if failed_list_str.strip():
    failed_websites = set(url.strip() for url in failed_list_str.split(',') if url.strip())

completed_websites = set()
if completed_list_str.strip():
    completed_websites = set(url.strip() for url in completed_list_str.split(',') if url.strip())

# Read all websites from CSV
all_websites = []
try:
    with open(csv_file, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get('page') and row['page'].strip():
                all_websites.append(row['page'].strip())
except Exception as e:
    print(f'Error reading CSV: {e}', file=sys.stderr)
    sys.exit(1)

# Calculate which websites need retrying
# 1. All failed websites
# 2. Websites that were never completed (missing from DB)

retry_websites = set()

# Add all failed websites
retry_websites.update(failed_websites)

# Add websites that don't have a completed DB file
for website in all_websites:
    # Extract domain from URL
    try:
        parsed = urlparse(website)
        domain = parsed.netloc or parsed.path
        if not domain:
            continue

        # Check if this website has a completed DB file
        # We'll match by checking if the website URL or domain exists in completed_websites
        # The DB files are named like "domain.com_.db"
        found = False
        for completed in completed_websites:
            # Use exact domain match to avoid false positives
            if domain == completed:
                found = True
                break

        if not found:
            retry_websites.add(website)
    except:
        continue

# Output retry websites as comma-separated
if retry_websites:
    retry_list = sorted(list(retry_websites))
    print(','.join(retry_list))
    print(f'Total websites to retry: {len(retry_list)}', file=sys.stderr)
else:
    print('')
    print('No websites need retrying', file=sys.stderr)
PYTHON_EOF
}

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
    print_success "Docker is running"
}

# Function to stop all existing containers
stop_existing_containers() {
    print_status "Stopping and removing all existing containers..."
    docker stop $(docker ps -q --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    docker rm $(docker ps -aq --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    print_success "All existing containers stopped and removed"
}

# Function to cleanup Docker
cleanup_docker() {
    print_status "Running cleanup_docker.sh..."
    if [ -f "../cleanup_docker.sh" ]; then
        bash ../cleanup_docker.sh
    else
        print_warning "cleanup_docker.sh not found, running basic cleanup..."
        sudo docker container prune -f
        sudo docker image prune -a -f
        sudo docker builder prune --all -f
    fi
    print_success "Docker cleanup completed"
}

# Function to build the Docker image
build_image() {
    print_status "Building Docker image: $IMAGE_NAME"
    if docker build -t $IMAGE_NAME .; then
        print_success "Docker image built successfully"
    else
        print_error "Failed to build Docker image"
        exit 1
    fi
}

# Function to start containers for retry websites
start_retry_containers() {
    local retry_websites=$1
    
    if [ -z "$retry_websites" ]; then
        print_warning "No websites to retry"
        return 0
    fi
    
    print_status "Starting containers for retry websites..."
    
    # Split websites into chunks for each container
    local total_websites=$(echo "$retry_websites" | tr ',' '\n' | wc -l)
    local websites_per_container=$((total_websites / TOTAL_CONTAINERS))
    if [ $websites_per_container -eq 0 ]; then
        websites_per_container=1
    fi
    
    print_status "Distributing $total_websites websites across $TOTAL_CONTAINERS containers"
    
    # Convert comma-separated to array
    local websites_array=($(echo "$retry_websites" | tr ',' ' '))
    local website_index=0
    local container_count=0
    
    for i in $(seq 1 $TOTAL_CONTAINERS); do
        if [ $website_index -ge ${#websites_array[@]} ]; then
            break
        fi
        
        container_name="${CONTAINER_PREFIX}-${i}"
        VNC_PORT=$((5900 + i))
        
        # Get websites for this container
        local container_websites=""
        local count=0
        
        while [ $count -lt $websites_per_container ] && [ $website_index -lt ${#websites_array[@]} ]; do
            if [ -n "$container_websites" ]; then
                container_websites="${container_websites},"
            fi
            container_websites="${container_websites}${websites_array[$website_index]}"
            website_index=$((website_index + 1))
            count=$((count + 1))
        done
        
        if [ -z "$container_websites" ]; then
            continue
        fi
        
        print_status "Starting container $container_name with $count websites..."
        
        docker run -d \
            --name $container_name \
            --cpus=2 \
            --shm-size=4g \
            --user crawler \
            -p $VNC_PORT:5900 \
            -v "$(pwd)/output:/home/XXXX-4/crawler/output" \
            -v "$(pwd)/$CSV_FILE:/app/leaky-sites.csv" \
            -e CONTAINER_ID=$i \
            -e TOTAL_CONTAINERS=$TOTAL_CONTAINERS \
            -e DISPLAY=:99 \
            -e VNC_PORT=$VNC_PORT \
            $IMAGE_NAME \
            /usr/local/bin/start-vnc.sh node crawler.js --container-id=$i --total-containers=$TOTAL_CONTAINERS --websites="$container_websites"
        
        if [ $? -eq 0 ]; then
            print_success "Container $container_name started (VNC: localhost:$VNC_PORT)"
            container_count=$((container_count + 1))
        else
            print_error "Failed to start container $container_name"
        fi
    done
    
    print_success "Started $container_count containers for retry websites"
}

# Function to show container status
show_status() {
    print_status "Container Status:"
    docker ps --filter "name=$CONTAINER_PREFIX" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
}

# Main execution
main() {
    print_status "Starting rerun_failures.sh"
    
    # Check Docker
    check_docker
    
    # Get the most recent date directory
    DATE_DIR=$(get_latest_date_dir)
    print_status "Using output directory: $DATE_DIR"
    
    # Parse failed websites from logs
    print_status "=== Step 1: Parsing failed websites from logs ==="
    FAILED_LIST=$(parse_failed_websites "$DATE_DIR")
    FAILED_COUNT=$(echo "$FAILED_LIST" | tr ',' '\n' | grep -v '^$' | wc -l)
    print_success "Found $FAILED_COUNT failed websites"
    
    # Parse completed websites from DB files
    print_status "=== Step 2: Finding completed websites from DB files ==="
    COMPLETED_LIST=$(parse_completed_websites "$DATE_DIR")
    COMPLETED_COUNT=$(echo "$COMPLETED_LIST" | tr ',' '\n' | grep -v '^$' | wc -l)
    print_success "Found $COMPLETED_COUNT completed websites"
    
    # Calculate websites to retry
    print_status "=== Step 3: Calculating websites to retry ==="
    RETRY_LIST=$(calculate_retry_list "$DATE_DIR" "$FAILED_LIST" "$COMPLETED_LIST")
    RETRY_COUNT=$(echo "$RETRY_LIST" | tr ',' '\n' | grep -v '^$' | wc -l)
    
    if [ $RETRY_COUNT -eq 0 ]; then
        print_success "No websites need to be retried!"
        exit 0
    fi
    
    print_success "Found $RETRY_COUNT websites to retry"
    
    # Stop existing containers
    print_status "=== Step 4: Stopping existing containers ==="
    stop_existing_containers
    
    # Cleanup Docker
    print_status "=== Step 5: Cleaning up Docker ==="
    cleanup_docker
    
    # Build image
    print_status "=== Step 6: Building Docker image ==="
    build_image
    
    # Start retry containers
    print_status "=== Step 7: Starting containers for retry websites ==="
    start_retry_containers "$RETRY_LIST"
    
    # Show status
    echo ""
    show_status
    
    print_success "Rerun completed! Use 'docker logs <container_name>' to check logs."
}

# Run main function
main "$@"
