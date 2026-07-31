#!/usr/bin/env bash
# Refuses to start an exact K=21 rehearsal unless the selected local
# filesystem and current process limits meet explicit, measurable floors.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 EXISTING_WORK_DIRECTORY" >&2
  exit 2
fi

WORK_DIR=$1
MIN_FREE_BYTES=${MPC_K21_MIN_FREE_BYTES:-$((100 * 1024 * 1024 * 1024))}
MIN_AVAILABLE_MEMORY_BYTES=${MPC_K21_MIN_AVAILABLE_MEMORY_BYTES:-$((16 * 1024 * 1024 * 1024))}
MIN_FREE_INODES=${MPC_K21_MIN_FREE_INODES:-100000}
MIN_OPEN_FILES=${MPC_K21_MIN_OPEN_FILES:-4096}
MIN_FILE_SIZE_LIMIT_BYTES=${MPC_K21_MIN_FILE_SIZE_LIMIT_BYTES:-$((16 * 1024 * 1024 * 1024))}
IO_PROBE_BYTES=${MPC_K21_IO_PROBE_BYTES:-$((256 * 1024 * 1024))}
IO_DIRECT=${MPC_K21_IO_DIRECT:-1}
MIN_WRITE_BYTES_PER_SECOND=${MPC_K21_MIN_WRITE_BYTES_PER_SECOND:-$((20 * 1024 * 1024))}
MIN_READ_BYTES_PER_SECOND=${MPC_K21_MIN_READ_BYTES_PER_SECOND:-$((20 * 1024 * 1024))}
REQUIRE_SWAP_DISABLED=${MPC_K21_REQUIRE_SWAP_DISABLED:-0}
REQUIRE_QUOTA_VISIBILITY=${MPC_K21_REQUIRE_QUOTA_VISIBILITY:-0}

require_nonnegative_integer() {
  local name=$1
  local value=$2
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "FAIL: $name must be a non-negative integer" >&2
    exit 1
  fi
}

for setting in \
  "MPC_K21_MIN_FREE_BYTES:$MIN_FREE_BYTES" \
  "MPC_K21_MIN_AVAILABLE_MEMORY_BYTES:$MIN_AVAILABLE_MEMORY_BYTES" \
  "MPC_K21_MIN_FREE_INODES:$MIN_FREE_INODES" \
  "MPC_K21_MIN_OPEN_FILES:$MIN_OPEN_FILES" \
  "MPC_K21_MIN_FILE_SIZE_LIMIT_BYTES:$MIN_FILE_SIZE_LIMIT_BYTES" \
  "MPC_K21_IO_PROBE_BYTES:$IO_PROBE_BYTES" \
  "MPC_K21_IO_DIRECT:$IO_DIRECT" \
  "MPC_K21_MIN_WRITE_BYTES_PER_SECOND:$MIN_WRITE_BYTES_PER_SECOND" \
  "MPC_K21_MIN_READ_BYTES_PER_SECOND:$MIN_READ_BYTES_PER_SECOND" \
  "MPC_K21_REQUIRE_SWAP_DISABLED:$REQUIRE_SWAP_DISABLED" \
  "MPC_K21_REQUIRE_QUOTA_VISIBILITY:$REQUIRE_QUOTA_VISIBILITY"; do
  require_nonnegative_integer "${setting%%:*}" "${setting#*:}"
done
if [[ "$REQUIRE_SWAP_DISABLED" != 0 && "$REQUIRE_SWAP_DISABLED" != 1 ]]; then
  echo "FAIL: MPC_K21_REQUIRE_SWAP_DISABLED must be 0 or 1" >&2
  exit 1
fi
if [[ "$REQUIRE_QUOTA_VISIBILITY" != 0 && "$REQUIRE_QUOTA_VISIBILITY" != 1 ]]; then
  echo "FAIL: MPC_K21_REQUIRE_QUOTA_VISIBILITY must be 0 or 1" >&2
  exit 1
fi
if [[ "$IO_DIRECT" != 0 && "$IO_DIRECT" != 1 ]]; then
  echo "FAIL: MPC_K21_IO_DIRECT must be 0 or 1" >&2
  exit 1
fi
if (( IO_PROBE_BYTES < 1048576 ||
  IO_PROBE_BYTES > 8 * 1024 * 1024 * 1024 ||
  IO_PROBE_BYTES % 1048576 != 0 )); then
  echo "FAIL: MPC_K21_IO_PROBE_BYTES must be a multiple of 1 MiB between 1 MiB and 8 GiB" >&2
  exit 1
fi

if [[ ! -d "$WORK_DIR" || -L "$WORK_DIR" ]]; then
  echo "FAIL: work directory must be an existing real directory: $WORK_DIR" >&2
  exit 1
fi

FS_TYPE=$(stat -f -c %T "$WORK_DIR")
case "$FS_TYPE" in
  ext2/ext3 | xfs | btrfs | zfs)
    ;;
  *)
    echo "FAIL: unqualified filesystem type $FS_TYPE for $WORK_DIR" >&2
    echo "Use a dedicated local ext4, XFS, Btrfs, or ZFS volume." >&2
    exit 1
    ;;
esac

FREE_BYTES=$(df -B1 --output=avail "$WORK_DIR" | tail -n 1 | tr -d ' ')
require_nonnegative_integer free_bytes "$FREE_BYTES"
if (( FREE_BYTES < MIN_FREE_BYTES )); then
  echo "FAIL: $WORK_DIR has $FREE_BYTES free bytes; configured floor is $MIN_FREE_BYTES" >&2
  exit 1
fi

FREE_INODES=$(df --output=iavail "$WORK_DIR" | tail -n 1 | tr -d ' ')
require_nonnegative_integer free_inodes "$FREE_INODES"
if (( FREE_INODES < MIN_FREE_INODES )); then
  echo "FAIL: $WORK_DIR has $FREE_INODES free inodes; configured floor is $MIN_FREE_INODES" >&2
  exit 1
fi

AVAILABLE_MEMORY_KIB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
require_nonnegative_integer MemAvailable_kib "$AVAILABLE_MEMORY_KIB"
HOST_AVAILABLE_MEMORY_BYTES=$((AVAILABLE_MEMORY_KIB * 1024))

CGROUP_VERSION=none
CGROUP_MEMORY_MAX=max
CGROUP_MEMORY_CURRENT=0
CGROUP_MEMORY_REMAINING=$HOST_AVAILABLE_MEMORY_BYTES
CGROUP_MEMORY_HIGH=max
CGROUP_SWAP_MAX=unknown
CGROUP_SWAP_CURRENT=0
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  CGROUP_VERSION=2
  CGROUP_RELATIVE=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
  if [[ -z "$CGROUP_RELATIVE" || "$CGROUP_RELATIVE" == *..* ]]; then
    echo "FAIL: could not resolve the current cgroup v2 path" >&2
    exit 1
  fi
  CGROUP_PATH="/sys/fs/cgroup$CGROUP_RELATIVE"
  for controller_file in memory.max memory.current memory.high memory.swap.max memory.swap.current; do
    if [[ ! -f "$CGROUP_PATH/$controller_file" ]]; then
      echo "FAIL: current cgroup lacks $controller_file" >&2
      exit 1
    fi
  done
  CGROUP_MEMORY_MAX=$(tr -d '\n' <"$CGROUP_PATH/memory.max")
  CGROUP_MEMORY_CURRENT=$(tr -d '\n' <"$CGROUP_PATH/memory.current")
  CGROUP_MEMORY_HIGH=$(tr -d '\n' <"$CGROUP_PATH/memory.high")
  CGROUP_SWAP_MAX=$(tr -d '\n' <"$CGROUP_PATH/memory.swap.max")
  CGROUP_SWAP_CURRENT=$(tr -d '\n' <"$CGROUP_PATH/memory.swap.current")
  require_nonnegative_integer cgroup_memory_current "$CGROUP_MEMORY_CURRENT"
  require_nonnegative_integer cgroup_swap_current "$CGROUP_SWAP_CURRENT"
  if [[ "$CGROUP_MEMORY_MAX" != max ]]; then
    require_nonnegative_integer cgroup_memory_max "$CGROUP_MEMORY_MAX"
    if (( CGROUP_MEMORY_CURRENT >= CGROUP_MEMORY_MAX )); then
      CGROUP_MEMORY_REMAINING=0
    else
      CGROUP_MEMORY_REMAINING=$((CGROUP_MEMORY_MAX - CGROUP_MEMORY_CURRENT))
    fi
  fi
elif [[ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then
  CGROUP_VERSION=1
  CGROUP_RELATIVE=$(
    awk -F: '$2 ~ /(^|,)memory(,|$)/ {print $3}' /proc/self/cgroup
  )
  if [[ -z "$CGROUP_RELATIVE" || "$CGROUP_RELATIVE" == *..* ]]; then
    echo "FAIL: could not resolve the current cgroup v1 memory path" >&2
    exit 1
  fi
  CGROUP_PATH="/sys/fs/cgroup/memory$CGROUP_RELATIVE"
  for controller_file in memory.limit_in_bytes memory.usage_in_bytes; do
    if [[ ! -f "$CGROUP_PATH/$controller_file" ]]; then
      echo "FAIL: current cgroup lacks $controller_file" >&2
      exit 1
    fi
  done
  CGROUP_MEMORY_MAX=$(tr -d '\n' <"$CGROUP_PATH/memory.limit_in_bytes")
  CGROUP_MEMORY_CURRENT=$(tr -d '\n' <"$CGROUP_PATH/memory.usage_in_bytes")
  require_nonnegative_integer cgroup_memory_max "$CGROUP_MEMORY_MAX"
  require_nonnegative_integer cgroup_memory_current "$CGROUP_MEMORY_CURRENT"
  if (( CGROUP_MEMORY_CURRENT >= CGROUP_MEMORY_MAX )); then
    CGROUP_MEMORY_REMAINING=0
  else
    CGROUP_MEMORY_REMAINING=$((CGROUP_MEMORY_MAX - CGROUP_MEMORY_CURRENT))
  fi
  if [[ -f "$CGROUP_PATH/memory.memsw.limit_in_bytes" &&
    -f "$CGROUP_PATH/memory.memsw.usage_in_bytes" ]]; then
    CGROUP_MEMSW_MAX=$(tr -d '\n' <"$CGROUP_PATH/memory.memsw.limit_in_bytes")
    CGROUP_MEMSW_CURRENT=$(tr -d '\n' <"$CGROUP_PATH/memory.memsw.usage_in_bytes")
    require_nonnegative_integer cgroup_memsw_max "$CGROUP_MEMSW_MAX"
    require_nonnegative_integer cgroup_memsw_current "$CGROUP_MEMSW_CURRENT"
    if (( CGROUP_MEMSW_MAX > CGROUP_MEMORY_MAX )); then
      CGROUP_SWAP_MAX=$((CGROUP_MEMSW_MAX - CGROUP_MEMORY_MAX))
    else
      CGROUP_SWAP_MAX=0
    fi
    if (( CGROUP_MEMSW_CURRENT > CGROUP_MEMORY_CURRENT )); then
      CGROUP_SWAP_CURRENT=$((CGROUP_MEMSW_CURRENT - CGROUP_MEMORY_CURRENT))
    else
      CGROUP_SWAP_CURRENT=0
    fi
  fi
fi

EFFECTIVE_AVAILABLE_MEMORY_BYTES=$HOST_AVAILABLE_MEMORY_BYTES
if (( CGROUP_MEMORY_REMAINING < EFFECTIVE_AVAILABLE_MEMORY_BYTES )); then
  EFFECTIVE_AVAILABLE_MEMORY_BYTES=$CGROUP_MEMORY_REMAINING
fi
if [[ "$CGROUP_MEMORY_HIGH" != max ]]; then
  require_nonnegative_integer cgroup_memory_high "$CGROUP_MEMORY_HIGH"
  if (( CGROUP_MEMORY_CURRENT >= CGROUP_MEMORY_HIGH )); then
    CGROUP_MEMORY_HIGH_REMAINING=0
  else
    CGROUP_MEMORY_HIGH_REMAINING=$((CGROUP_MEMORY_HIGH - CGROUP_MEMORY_CURRENT))
  fi
  if (( CGROUP_MEMORY_HIGH_REMAINING < EFFECTIVE_AVAILABLE_MEMORY_BYTES )); then
    EFFECTIVE_AVAILABLE_MEMORY_BYTES=$CGROUP_MEMORY_HIGH_REMAINING
  fi
fi
if (( EFFECTIVE_AVAILABLE_MEMORY_BYTES < MIN_AVAILABLE_MEMORY_BYTES )); then
  echo "FAIL: effective available memory is $EFFECTIVE_AVAILABLE_MEMORY_BYTES bytes; configured floor is $MIN_AVAILABLE_MEMORY_BYTES" >&2
  exit 1
fi

HOST_SWAP_ACTIVE_BYTES=$(
  awk 'NR > 1 {total += $4} END {printf "%.0f", total * 1024}' /proc/swaps
)
HOST_SWAP_CONFIGURED_BYTES=$(
  awk 'NR > 1 {total += $3} END {printf "%.0f", total * 1024}' /proc/swaps
)
require_nonnegative_integer host_swap_active_bytes "$HOST_SWAP_ACTIVE_BYTES"
require_nonnegative_integer host_swap_configured_bytes "$HOST_SWAP_CONFIGURED_BYTES"
if (( REQUIRE_SWAP_DISABLED == 1 )); then
  if (( HOST_SWAP_CONFIGURED_BYTES != 0 || HOST_SWAP_ACTIVE_BYTES != 0 ||
    CGROUP_SWAP_CURRENT != 0 )); then
    echo "FAIL: configured or active swap is forbidden by MPC_K21_REQUIRE_SWAP_DISABLED=1" >&2
    exit 1
  fi
fi

OPEN_FILES_LIMIT=$(ulimit -Sn)
require_nonnegative_integer open_files_soft_limit "$OPEN_FILES_LIMIT"
if (( OPEN_FILES_LIMIT < MIN_OPEN_FILES )); then
  echo "FAIL: open-file soft limit is $OPEN_FILES_LIMIT; configured floor is $MIN_OPEN_FILES" >&2
  exit 1
fi
FILE_SIZE_LIMIT_BLOCKS=$(ulimit -Sf)
if [[ "$FILE_SIZE_LIMIT_BLOCKS" == unlimited ]]; then
  FILE_SIZE_LIMIT_BYTES=unlimited
elif [[ "$FILE_SIZE_LIMIT_BLOCKS" =~ ^[0-9]+$ ]]; then
  FILE_SIZE_LIMIT_BYTES=$((FILE_SIZE_LIMIT_BLOCKS * 512))
  if (( FILE_SIZE_LIMIT_BYTES < MIN_FILE_SIZE_LIMIT_BYTES )); then
    echo "FAIL: file-size soft limit is $FILE_SIZE_LIMIT_BYTES bytes; configured floor is $MIN_FILE_SIZE_LIMIT_BYTES" >&2
    exit 1
  fi
else
  echo "FAIL: could not parse file-size soft limit" >&2
  exit 1
fi

MOUNT_OPTIONS=unknown
if command -v findmnt >/dev/null 2>&1; then
  MOUNT_OPTIONS=$(findmnt -T "$WORK_DIR" -n -o OPTIONS | tr -d '\n')
fi
QUOTA_VISIBILITY=none
if [[ "$MOUNT_OPTIONS" == *quota* ]]; then
  QUOTA_VISIBILITY=mount-options
fi
if command -v quota >/dev/null 2>&1; then
  if QUOTA_OUTPUT=$(timeout 5 quota -s 2>&1); then
    QUOTA_VISIBILITY=quota-command
  else
    QUOTA_OUTPUT=unavailable
  fi
else
  QUOTA_OUTPUT=not-installed
fi
QUOTA_OUTPUT=${QUOTA_OUTPUT//$'\n'/;}
QUOTA_OUTPUT=${QUOTA_OUTPUT//$'\t'/ }
if (( REQUIRE_QUOTA_VISIBILITY == 1 )) && [[ "$QUOTA_VISIBILITY" == none ]]; then
  echo "FAIL: quota visibility is required but no quota signal is available" >&2
  exit 1
fi

PROBE_DIR=$(mktemp -d "$WORK_DIR/.mpc-capacity-probe.XXXXXXXX")
cleanup() {
  rm -rf -- "$PROBE_DIR"
}
trap cleanup EXIT

printf 'mpc-capacity-source\n' >"$PROBE_DIR/source"
printf 'mpc-capacity-target\n' >"$PROBE_DIR/collision-target"
cp "$PROBE_DIR/source" "$PROBE_DIR/collision-source"
if mv -Tn "$PROBE_DIR/collision-source" "$PROBE_DIR/collision-target" 2>/dev/null; then
  :
fi
if [[ ! -f "$PROBE_DIR/collision-source" ]] ||
  [[ "$(tr -d '\n' <"$PROBE_DIR/collision-target")" != mpc-capacity-target ]]; then
  echo "FAIL: no-clobber rename collision probe overwrote an existing target" >&2
  exit 1
fi
ln "$PROBE_DIR/source" "$PROBE_DIR/published"
if ln "$PROBE_DIR/source" "$PROBE_DIR/published" 2>/dev/null; then
  echo "FAIL: no-replace hard-link publication accepted a collision" >&2
  exit 1
fi
cmp "$PROBE_DIR/source" "$PROBE_DIR/published"
sync -f "$PROBE_DIR/source"
sync -f "$PROBE_DIR"

IO_FILE="$PROBE_DIR/sustained-io.bin"
IO_COUNT=$((IO_PROBE_BYTES / 1048576))
WRITE_FLAGS=(conv=fsync)
READ_FLAGS=()
if (( IO_DIRECT == 1 )); then
  WRITE_FLAGS+=(oflag=direct)
  READ_FLAGS+=(iflag=direct)
fi
WRITE_START_NS=$(date +%s%N)
dd if=/dev/zero of="$IO_FILE" bs=1048576 count="$IO_COUNT" \
  "${WRITE_FLAGS[@]}" status=none
WRITE_END_NS=$(date +%s%N)
READ_START_NS=$(date +%s%N)
dd if="$IO_FILE" of=/dev/null bs=1048576 "${READ_FLAGS[@]}" status=none
READ_END_NS=$(date +%s%N)
WRITE_ELAPSED_NS=$((WRITE_END_NS - WRITE_START_NS))
READ_ELAPSED_NS=$((READ_END_NS - READ_START_NS))
if (( WRITE_ELAPSED_NS <= 0 || READ_ELAPSED_NS <= 0 )); then
  echo "FAIL: sustained I/O timer did not advance" >&2
  exit 1
fi
WRITE_BYTES_PER_SECOND=$((IO_PROBE_BYTES * 1000000000 / WRITE_ELAPSED_NS))
READ_BYTES_PER_SECOND=$((IO_PROBE_BYTES * 1000000000 / READ_ELAPSED_NS))
if (( WRITE_BYTES_PER_SECOND < MIN_WRITE_BYTES_PER_SECOND )); then
  echo "FAIL: measured fsync write rate is $WRITE_BYTES_PER_SECOND B/s; configured floor is $MIN_WRITE_BYTES_PER_SECOND" >&2
  exit 1
fi
if (( READ_BYTES_PER_SECOND < MIN_READ_BYTES_PER_SECOND )); then
  echo "FAIL: measured read rate is $READ_BYTES_PER_SECOND B/s; configured floor is $MIN_READ_BYTES_PER_SECOND" >&2
  exit 1
fi

echo "OK: K=21 work volume passed resource, I/O, and publication probes"
echo "filesystem=$FS_TYPE free_bytes=$FREE_BYTES free_inodes=$FREE_INODES"
echo "host_available_memory_bytes=$HOST_AVAILABLE_MEMORY_BYTES effective_available_memory_bytes=$EFFECTIVE_AVAILABLE_MEMORY_BYTES"
echo "cgroup_version=$CGROUP_VERSION cgroup_memory_max=$CGROUP_MEMORY_MAX cgroup_memory_current=$CGROUP_MEMORY_CURRENT cgroup_memory_high=$CGROUP_MEMORY_HIGH"
echo "host_swap_configured_bytes=$HOST_SWAP_CONFIGURED_BYTES host_swap_active_bytes=$HOST_SWAP_ACTIVE_BYTES cgroup_swap_max=$CGROUP_SWAP_MAX cgroup_swap_current=$CGROUP_SWAP_CURRENT swap_disabled_required=$REQUIRE_SWAP_DISABLED"
echo "open_files_soft_limit=$OPEN_FILES_LIMIT file_size_soft_limit_bytes=$FILE_SIZE_LIMIT_BYTES"
echo "io_probe_bytes=$IO_PROBE_BYTES io_direct=$IO_DIRECT fsync_write_bytes_per_second=$WRITE_BYTES_PER_SECOND read_bytes_per_second=$READ_BYTES_PER_SECOND"
echo "mount_options=$MOUNT_OPTIONS quota_visibility=$QUOTA_VISIBILITY quota_command=$QUOTA_OUTPUT"
