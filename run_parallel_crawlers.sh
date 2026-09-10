#!/bin/bash

# Configuration
TOTAL_CONTAINERS=20
CONTAINER_PREFIX="crawler"
IMAGE_NAME="leakyweb-crawler"

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

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
    print_success "Docker is running"
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

# Function to create web-secrets directory
create_web_secrets_dir() {
    if [ ! -d "/mnt/web-secrets/output" ]; then
        sudo mkdir -p /mnt/web-secrets/output
        print_status "Created /mnt/web-secrets/output directory"
    fi
}

# Function to stop all existing containers
stop_existing_containers() {
    print_status "Stopping existing crawler containers..."
    docker stop $(docker ps -q --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    docker rm $(docker ps -aq --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    print_success "Existing containers stopped and removed"
}

# Function to get websites for a specific container
get_container_websites() {
    local container_id=$1
    local total_websites=$2
    local websites_per_container=$3
    local remainder=$4
    
    # Calculate start and end indices for this container
    local start_index=0
    for i in $(seq 1 $container_id); do
        local end_index=$((start_index + websites_per_container))
        if [ $i -le $remainder ]; then
            end_index=$((end_index + 1))
        fi
        if [ $i -eq $container_id ]; then
            # Extract websites for this container
            python3 -c "
import csv
import sys
container_id = int(sys.argv[1])
start_idx = int(sys.argv[2])
end_idx = int(sys.argv[3])

websites = []
with open('leaky-sites.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row['page'] and row['page'].strip():
            if row['page'].strip() in ['https://insights.smartocto.com/', 'http://boutiqaat.com/']:
                continue
            websites.append(row['page'].strip())

# Sort and get unique websites
websites = sorted(list(set(websites)))
container_websites = websites[start_idx:end_idx]

# Output as comma-separated string
print(','.join(container_websites))
" $container_id $start_index $end_index
            return
        fi
        start_index=$end_index
    done
}

# Function to start containers
start_containers() {
    print_status "Starting $TOTAL_CONTAINERS parallel crawler containers..."
    
    # First, get total websites count for distribution calculation
    local total_websites=$(python3 -c "
import csv
websites = set()
with open('leaky-sites.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row['page'] and row['page'].strip():
            if row['page'].strip() in ['https://insights.smartocto.com/', 'http://boutiqaat.com/']:
                continue
            websites.add(row['page'].strip())
print(len(websites))
")
    
    if [ $total_websites -eq 0 ]; then
        print_error "No websites found in CSV file!"
        exit 1
    fi
    
    # Calculate distribution
    local websites_per_container=$((total_websites / TOTAL_CONTAINERS))
    local remainder=$((total_websites % TOTAL_CONTAINERS))
    
    print_success "Found $total_websites unique websites to distribute"
    print_status "Each container will process approximately $websites_per_container websites"
    
    for i in $(seq 1 $TOTAL_CONTAINERS); do
        container_name="${CONTAINER_PREFIX}-${i}"
        print_status "Starting container $container_name..."
        
        # Calculate unique VNC port for each container (5900 + container_id)
        VNC_PORT=$((5900 + i))
        
        # Get websites for this container as comma-separated string
        local websites_csv=$(get_container_websites $i $total_websites $websites_per_container $remainder)
        
        if [ -z "$websites_csv" ]; then
            print_error "No websites found for container $i"
            continue
        fi
        
        # Count websites for this container
        local website_count=$(echo "$websites_csv" | tr ',' '\n' | wc -l)
        print_status "Container $i: $website_count websites"
        
        docker run -d \
            --name $container_name \
            --cpus=2 \
            --shm-size=4g \
            --user crawler \
            -p $VNC_PORT:5900 \
            -v "$(pwd)/output:/home/XXXX-4/crawler/output" \
            -v "$(pwd)/leaky-sites.csv:/app/leaky-sites.csv" \
            -e CONTAINER_ID=$i \
            -e TOTAL_CONTAINERS=$TOTAL_CONTAINERS \
            -e DISPLAY=:99 \
            -e VNC_PORT=$VNC_PORT \
            $IMAGE_NAME \
            /usr/local/bin/start-vnc.sh node crawler.js --container-id=$i --total-containers=$TOTAL_CONTAINERS --websites="$websites_csv"
        
        if [ $? -eq 0 ]; then
            print_success "Container $container_name started successfully (VNC: localhost:$VNC_PORT)"
        else
            print_error "Failed to start container $container_name"
        fi
    done
}

# Function to show container status
show_status() {
    print_status "Container Status:"
    docker ps --filter "name=$CONTAINER_PREFIX" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    
    print_status "VNC Connection Details:"
    for i in $(seq 1 $TOTAL_CONTAINERS); do
        container_name="${CONTAINER_PREFIX}-${i}"
        VNC_PORT=$((5900 + i))
        if docker ps --format "{{.Names}}" | grep -q "^$container_name$"; then
            echo "  Container $container_name: VNC at localhost:$VNC_PORT"
        fi
    done
}

# Function to show logs
show_logs() {
    local container_name=$1
    if [ -z "$container_name" ]; then
        print_status "Showing logs for all containers (last 20 lines each):"
        for i in $(seq 1 $TOTAL_CONTAINERS); do
            container_name="${CONTAINER_PREFIX}-${i}"
            if docker ps --format "{{.Names}}" | grep -q "^$container_name$"; then
                echo -e "\n${BLUE}=== Logs for $container_name ===${NC}"
                docker logs --tail 20 $container_name
            fi
        done
    else
        print_status "Showing logs for $container_name:"
        docker logs -f $container_name
    fi
}

# Function to stop all containers
stop_containers() {
    print_status "Stopping all crawler containers..."
    docker stop $(docker ps -q --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    print_success "All containers stopped"
}

# Function to clean up
cleanup() {
    print_status "Cleaning up containers and images..."
    docker stop $(docker ps -q --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    docker rm $(docker ps -aq --filter "name=$CONTAINER_PREFIX") 2>/dev/null || true
    docker rmi $IMAGE_NAME 2>/dev/null || true
    
    print_success "Cleanup completed"
}

# Function to show help
show_help() {
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  start     - Build image and start all containers"
    echo "  stop      - Stop all containers"
    echo "  restart   - Stop and start all containers"
    echo "  status    - Show container status and VNC ports"
    echo "  logs      - Show logs for all containers"
    echo "  logs [N]  - Show logs for specific container (1-$TOTAL_CONTAINERS)"
    echo "  cleanup   - Stop containers and remove image"
    echo "  help      - Show this help message"
    echo ""
    echo "VNC Access:"
    echo "  Each container runs a VNC server for headed browser mode"
    echo "  Connect using VNC viewer to localhost:PORT"
    echo "  Ports: 5901, 5902, 5903, ... (5900 + container_id)"
    echo ""
    echo "Configuration:"
    echo "  TOTAL_CONTAINERS=$TOTAL_CONTAINERS (edit script to change)"
    echo "  Output directory: /mnt/web-secrets/output"
}

# Main script logic
case "${1:-start}" in
    "start")
        check_docker
        create_web_secrets_dir
        build_image
        stop_existing_containers
        start_containers
        show_status
        print_success "All containers started! Use '$0 status' to check status or '$0 logs' to see logs."
        ;;
    "stop")
        stop_containers
        ;;
    "restart")
        stop_containers
        sleep 2
        start_containers
        show_status
        ;;
    "status")
        show_status
        ;;
    "logs")
        show_logs $2
        ;;
    "cleanup")
        cleanup
        ;;
    "help")
        show_help
        ;;
    *)
        print_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
