FROM vikunja/vikunja:2.7.0@sha256:e2204a1c1c6a81e833c2b3a5442be182ca2335b54c2e7e37578cc3fe12a27cfc AS upstream
FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
WORKDIR /app/vikunja
COPY --from=upstream /app/vikunja/vikunja /app/vikunja/vikunja
COPY --from=upstream /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY deploy/vikunja/*.sh /deploy/
ENV VIKUNJA_SERVICE_ROOTPATH=/app/vikunja/ VIKUNJA_DATABASE_TYPE=postgres VIKUNJA_DATABASE_HOST=postgres VIKUNJA_DATABASE_USER=antseed VIKUNJA_DATABASE_DATABASE=vikunja VIKUNJA_SERVICE_ENABLEREGISTRATION=false VIKUNJA_LOG_LEVEL=WARNING
EXPOSE 3456
ENTRYPOINT ["/bin/sh", "/deploy/start.sh"]
