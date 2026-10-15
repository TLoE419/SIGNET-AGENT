args <- commandArgs(TRUE);root <- normalizePath(args[1],mustWork=TRUE)
setwd(file.path(root,'res/resv'))
for (package in c('igraph','dnet','visNetwork','STRINGdb','TFutils','shiny','shinyfullscreen','shinycustomloader','shinydashboard','plotly','DT','circlize','ggthemes','fmsb')) suppressPackageStartupMessages(library(package,character.only=TRUE))
load(file.path(root,'official-session.RData'),envir=.GlobalEnv)
stopifnot(exists('ui'),exists('server'),is.function(server))
if(args[2]=='check'){cat('SIGNET_SESSION_LOADED\n');quit(status=0)}
Sys.setenv(resv=file.path(root,'res/resv/signet'),assembly='hg38',nchr='22')
ui <- htmltools::tagList(shiny::tags$head(shiny::tags$meta(name='signet-viewer-token',content=args[4])),ui)
shiny::runApp(shiny::shinyApp(ui=ui,server=server),host='127.0.0.1',port=as.integer(args[3]),launch.browser=FALSE)
