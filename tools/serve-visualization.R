root <- commandArgs(TRUE)[1]
setwd(file.path(root, "res/resv"))
# Reattach the libraries used by the official saved UI and server.
for (package in c("igraph", "dnet", "visNetwork", "STRINGdb", "TFutils", "shiny",
                  "shinyfullscreen", "shinycustomloader", "shinydashboard", "plotly",
                  "DT", "circlize", "ggthemes", "fmsb")) {
  suppressPackageStartupMessages(library(package, character.only=TRUE))
}
load("official-session.RData", envir=.GlobalEnv)
Sys.setenv(resv=file.path(root, "res/resv/signet"))
settings <- readLines(file.path(root, "config.ini"))
for (key in c("assembly", "nchr")) {
  value <- sub("^[^=]*=[[:space:]]*", "", grep(paste0("^", key, "[[:space:]]*="), settings, value=TRUE)[1])
  do.call(Sys.setenv, setNames(list(trimws(value)), key))
}
args <- commandArgs(TRUE)
ui <- htmltools::tagList(shiny::tags$head(shiny::tags$meta(name="signet-viewer-token", content=args[3])), ui)
shiny::runApp(shiny::shinyApp(ui=ui, server=server), host="127.0.0.1", port=as.integer(args[2]), launch.browser=FALSE)
