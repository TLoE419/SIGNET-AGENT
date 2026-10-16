args <- commandArgs(TRUE);root <- normalizePath(args[1],mustWork=TRUE)
setwd(file.path(root,'res/resv'))
for (package in c('igraph','dnet','visNetwork','STRINGdb','TFutils','shiny','shinyfullscreen','shinycustomloader','shinydashboard','plotly','DT','circlize','ggthemes','fmsb')) suppressPackageStartupMessages(library(package,character.only=TRUE))
source(file.path(root,'resource-client.R'),local=.GlobalEnv)
# Inherited FD0 is the very same kernel-sealed FD checked by the native owner.
(function(sessionPath,expectedHash){
  identity <- function() file.info(sessionPath)[,c('size','isdir','mode','mtime','ctime','uid','gid'),drop=FALSE]
  before <- identity()
  stopifnot(digest::digest(file=sessionPath,algo='sha256')==expectedHash)
  con <- file(sessionPath,'rb');on.exit(close(con))
  load(con,envir=.GlobalEnv)
  stopifnot(identical(before,identity()),digest::digest(file=sessionPath,algo='sha256')==expectedHash)
  cat('SIGNET_IMMUTABLE_FD_LOADED\n')
})('/proc/self/fd/0',args[3])
# save.image also restores prepare's args; service/check arguments remain native inputs.
args <- base::commandArgs(TRUE)
root <- normalizePath(args[1],mustWork=TRUE)
stopifnot(exists('ui'),exists('server'),is.function(server))
if(args[2]=='check'){cat('SIGNET_SESSION_LOADED\n');quit(status=0)}
Sys.setenv(resv=file.path(root,'res/resv/signet'),assembly='hg38',nchr='22')
ui <- htmltools::tagList(shiny::tags$head(shiny::tags$meta(name='signet-viewer-token',content=args[5])),ui)
shiny::runApp(shiny::shinyApp(ui=ui,server=server),host='127.0.0.1',port=as.integer(args[4]),launch.browser=FALSE)
