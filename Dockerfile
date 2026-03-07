# Single stage: no model blobs in the image. Models are built into the volume on first run.
FROM ollama/ollama

COPY modelfiles/ /modelfiles/
COPY scripts/build-models.sh /scripts/build-models.sh
COPY scripts/entrypoint.sh /scripts/entrypoint.sh
RUN chmod +x /scripts/build-models.sh /scripts/entrypoint.sh

EXPOSE 11434

ENTRYPOINT ["/scripts/entrypoint.sh"]
CMD ["serve"]
