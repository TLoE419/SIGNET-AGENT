FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tzdata slurm-wlm munge openssh-client perl python3 squashfs-tools \
    fuse2fs fuse-overlayfs uidmap libfuse2 && \
    curl -fL https://github.com/apptainer/apptainer/releases/download/v1.3.6/apptainer_1.3.6_amd64.deb -o /tmp/apptainer.deb && \
    apt-get install -y /tmp/apptainer.deb && rm /tmp/apptainer.deb && \
    ln -s /usr/bin/apptainer /usr/local/bin/singularity
COPY local-slurm.sh /usr/local/bin/local-slurm
RUN chmod +x /usr/local/bin/local-slurm
ENTRYPOINT ["/usr/local/bin/local-slurm"]
